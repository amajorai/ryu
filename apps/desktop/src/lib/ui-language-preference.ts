import type { LanguageMode } from "@/src/hooks/useLanguageMode.ts";
import type { ApiTarget } from "./api/client.ts";
import { getPreference, setPreference } from "./api/preferences.ts";

// Desktop keeps its language choice in localStorage, which the Island (a
// separate Electron process) cannot read. Desktop therefore mirrors the choice
// into Core's preference store under the key the Island reads
// (`apps/island/src/shared/language-selection.ts`), as `{ mode, packId }`:
// `auto` follows the OS language and carries no pack; `fixed` carries the
// chosen pack id, where `null` is an explicit English choice.

/** Core preference key shared with the Island (`UI_LANGUAGE_PREF_KEY`). */
export const UI_LANGUAGE_PREF_KEY = "ui-language";

const MAX_PACK_ID_LENGTH = 128;

export interface UiLanguagePreference {
	mode: LanguageMode;
	packId: string | null;
}

/** Normalize Desktop's mode and runtime pack id into the shared shape. */
export function uiLanguagePreference(
	mode: LanguageMode,
	packId: string | null
): UiLanguagePreference {
	if (mode === "auto") {
		return { mode, packId: null };
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
	return JSON.stringify({ mode: preference.mode, packId: preference.packId });
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
 * for a node in this session only seeds an unset key, so launching Desktop
 * never overrides a choice made in the Island; later syncs are explicit
 * Desktop changes and always write. The choice is claimed before any request
 * so concurrent identical syncs (StrictMode, several bridges) act once.
 * Failures are swallowed and restore the previous claim, so a later sync
 * retries.
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
		if (previous === undefined) {
			const existing = await getPreference(target, UI_LANGUAGE_PREF_KEY);
			if (existing !== null) {
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
