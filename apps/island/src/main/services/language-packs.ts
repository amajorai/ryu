import { type LanguagePack, validateLanguagePack } from "@ryu/i18n/core";
import type { LanguagePacksResult } from "../../shared/ipc.ts";
import { coreHeaders, loadConfig } from "./config.ts";

const PROBE_TIMEOUT_MS = 5000;

/** Read validated, data-only language packs for the isolated Island renderer. */
export async function languagePacks(): Promise<LanguagePacksResult> {
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
		const body = (await response.json()) as { packs?: unknown };
		if (!Array.isArray(body.packs)) {
			return { available: true, packs: [] };
		}
		const packs: LanguagePack[] = [];
		for (const raw of body.packs) {
			try {
				const pack = validateLanguagePack(raw);
				const enabled =
					typeof raw === "object" &&
					raw !== null &&
					"enabled" in raw &&
					typeof raw.enabled === "boolean"
						? raw.enabled
						: true;
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
