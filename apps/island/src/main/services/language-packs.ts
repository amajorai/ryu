import { type LanguagePack, validateLanguagePack } from "@ryu/i18n/core";
import { BUILT_IN_LANGUAGE_PACKS } from "@ryu/i18n/messages";
import { z } from "zod";
import type { LanguagePacksResult } from "../../shared/ipc.ts";
import {
	type LanguagePacksSnapshot,
	parseUiLanguageSelection,
	UI_LANGUAGE_PREF_KEY,
	type UiLanguageSelection,
} from "../../shared/language-selection.ts";
import { coreHeaders, loadConfig } from "./config.ts";
import { getPreferenceRaw, setPreferenceRaw } from "./preferences.ts";

const PROBE_TIMEOUT_MS = 5000;
const packsResponseSchema = z
	.object({ packs: z.array(z.unknown()).catch(() => []) })
	.catch(() => ({ packs: [] }));
const packEnabledSchema = z
	.object({ enabled: z.boolean().catch(true) })
	.catch(() => ({ enabled: true }));

/**
 * Read the catalog and the saved UI language for both Island windows. The main
 * process is the single source of truth, so the windows never disagree.
 */
export async function languagePacks(): Promise<LanguagePacksSnapshot> {
	const [catalog, selectionRaw] = await Promise.all([
		installedLanguagePacks(),
		getPreferenceRaw(UI_LANGUAGE_PREF_KEY),
	]);
	if (!catalog.available) {
		return catalog;
	}
	return { ...catalog, selection: parseUiLanguageSelection(selectionRaw) };
}

/**
 * Save a choice made in the Island picker as a fixed selection. Only English
 * (`null`), a built-in pack or a pack installed in Core is accepted, so a
 * stale or forged id never reaches the preference other windows read.
 */
export async function selectLanguagePack(
	packId: string | null
): Promise<boolean> {
	if (packId !== null && !(await isSelectablePack(packId))) {
		return false;
	}
	const selection: UiLanguageSelection = { mode: "fixed", packId };
	return setPreferenceRaw(UI_LANGUAGE_PREF_KEY, JSON.stringify(selection));
}

async function isSelectablePack(packId: string): Promise<boolean> {
	if (BUILT_IN_LANGUAGE_PACKS.some((pack) => pack.id === packId)) {
		return true;
	}
	const catalog = await installedLanguagePacks();
	return catalog.available && catalog.packs.some((pack) => pack.id === packId);
}

/** Read validated, data-only language packs for the isolated Island renderer. */
async function installedLanguagePacks(): Promise<LanguagePacksResult> {
	const { coreBaseUrl } = loadConfig();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(
			`${coreBaseUrl}/api/language-packs/installed`,
			{
				headers: coreHeaders(),
				signal: controller.signal,
			}
		);
		if (!response.ok) {
			return {
				available: false,
				reason: `core responded ${response.status}`,
			};
		}
		const body = packsResponseSchema.parse(await response.json());
		const packs: LanguagePack[] = [];
		for (const raw of body.packs) {
			try {
				const pack = validateLanguagePack(raw);
				const enabled = packEnabledSchema.parse(raw).enabled;
				packs.push({ ...pack, enabled });
			} catch {
				// One malformed record must not hide the rest of the catalog.
			}
		}
		return { available: true, packs };
	} catch {
		return { available: false, reason: "language-pack catalog unavailable" };
	} finally {
		clearTimeout(timer);
	}
}
