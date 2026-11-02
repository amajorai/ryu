import type { LanguageMode } from "@/src/hooks/useLanguageMode.ts";
import type { ApiTarget } from "./api/client.ts";
import { getPreference, setPreference } from "./api/preferences.ts";

// Desktop keeps its language choice in localStorage, which the Island (a
// separate Electron process) cannot read. Desktop therefore mirrors the choice
// into Core's preference store under the key the Island reads
// (`apps/island/src/shared/language-selection.ts`), as `{ mode, packId }`:
// `auto` follows the OS language and carries no pack; `fixed` carries the
// chosen pack id, where `null` is an explicit English choice. In `auto` mode
// Desktop also records the `locale` it actually shows, so Core's own messages
// (toasts, node email, pushes) follow the UI rather than re-probing the OS
// (`locale_from_preference` in `apps/core/src/i18n/locale.rs`).

/** Core preference key shared with the Island (`UI_LANGUAGE_PREF_KEY`). */
export const UI_LANGUAGE_PREF_KEY = "ui-language";

const MAX_PACK_ID_LENGTH = 128;
const MAX_LOCALE_LENGTH = 35;
const LOCALE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

export interface UiLanguagePreference {
	/** Auto mode only: the locale Desktop resolved from the OS languages. */
	locale?: string;
	mode: LanguageMode;
	packId: string | null;
}

/**
 * Normalize Desktop's mode, runtime pack id and (auto mode) shown locale into
 * the shared shape.
 */
export function uiLanguagePreference(
	mode: LanguageMode,
	packId: string | null,
	locale?: string | null
): UiLanguagePreference {
	if (mode === "auto") {
		const tag = locale?.trim().replaceAll("_", "-");
		return tag && tag.length <= MAX_LOCALE_LENGTH && LOCALE_TAG.test(tag)
			? { locale: tag, mode, packId: null }
			: { mode, packId: null };
	}
	const valid =
		typeof packId === "string" &&
		packId.length > 0 &&
		packId.length <= MAX_PACK_ID_LENGTH;
	return { mode, packId: valid ? packId : null };
}

export function serializeUiLanguagePreference(
	preference: UiLanguagePreference
): string {
	return JSON.stringify(
		preference.mode === "auto" && preference.locale
			? { mode: "auto", packId: null, locale: preference.locale }
			: { mode: preference.mode, packId: preference.packId }
	);
}

/** Mode and pack only: what the person chose, without the resolved locale. */
function choiceOf(value: string): string {
	try {
		const parsed = JSON.parse(value) as { mode?: unknown; packId?: unknown };
		return `${String(parsed.mode)}:${String(parsed.packId ?? "")}`;
	} catch {
		return value;
	}
}

/**
 * Whether `value` may replace a stored value without overriding a choice: an
 * unset key, or an `auto` value refreshed with another `auto` locale.
 */
function refreshable(existing: string | null, value: string): boolean {
	if (existing === null) {
		return true;
	}
	return (
		choiceOf(existing).startsWith("auto:") &&
		choiceOf(value).startsWith("auto:")
	);
}

/**
 * Desktop's choice as last synced for each node. A sync only acts when
 * Desktop's own choice changed, so remounts and re-renders never overwrite a
 * newer choice made in the Island.
 */
const lastSynced = new Map<string, string>();

function targetIdentity(target: ApiTarget): string {
	return target.url;
}

/**
 * Mirror Desktop's language choice to the shared preference. The first sync
 * for a node in this session only seeds an unset key (or refreshes an `auto`
 * one with the shown locale), so launching Desktop never overrides a choice
 * made in the Island; later choice changes are explicit Desktop changes and
 * always write. A change of the auto-mode locale alone (the OS language
 * changed) is not a choice, so it too only refreshes an `auto` value.
 * The choice is claimed before any request so concurrent identical syncs
 * (StrictMode, several bridges) act once. Failures are swallowed and restore
 * the previous claim, so a later sync retries.
 */
export async function syncUiLanguagePreference(
	target: ApiTarget,
	preference: UiLanguagePreference
): Promise<boolean> {
	const identity = targetIdentity(target);
	const value = serializeUiLanguagePreference(preference);
	const previous = lastSynced.get(identity);
	if (previous === value) {
		return false;
	}
	lastSynced.set(identity, value);
	try {
		const isChoice =
			previous !== undefined && choiceOf(previous) !== choiceOf(value);
		if (!isChoice) {
			const existing = await getPreference(target, UI_LANGUAGE_PREF_KEY);
			if (existing === value || !refreshable(existing, value)) {
				return false;
			}
		}
		await setPreference(target, UI_LANGUAGE_PREF_KEY, value);
		return true;
	} catch {
		if (lastSynced.get(identity) === value) {
			if (previous === undefined) {
				lastSynced.delete(identity);
			} else {
				lastSynced.set(identity, previous);
			}
		}
		return false;
	}
}

/** Test seam: forget each node's synced choice. */
export function resetUiLanguagePreferenceSync(): void {
	lastSynced.clear();
}
