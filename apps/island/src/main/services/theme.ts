// Main-process client for Core's shared theme preference (`/api/preferences`).
//
// The island companion is a separate Electron process and cannot read the
// desktop's `localStorage`, so theme sync rides Core: the desktop writes the
// theme blob under the `theme` preference key, and this service reads it and
// subscribes to Core's SSE change stream. The main process treats the blob as
// an opaque JSON string — all parsing/applying happens in the renderer with
// `@ryu/ui/theme` (which stays out of main: the main bundle inlines workspace
// packages and `@ryu/ui` is renderer UI code).

import { subscribePreferenceChanges } from "./preference-stream.ts";
import { getPreferenceRaw } from "./preferences.ts";

/** Preference key for the shared theme blob (matches `@ryu/ui` THEME_PREF_KEY). */
const THEME_KEY = "theme";
/** Read the current theme blob (raw JSON), or `null` if unset/unreachable. */
export async function getThemePrefsRaw(): Promise<string | null> {
	return getPreferenceRaw(THEME_KEY);
}

export function subscribeThemeChanges(
	onValue: (value: string) => void
): () => void {
	return subscribePreferenceChanges(THEME_KEY, onValue);
}
