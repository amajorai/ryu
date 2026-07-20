// Island command-shortcut preference: the cross-process contract persisted in
// Core under the `island-command-shortcut` key. This is the global hotkey that
// summons the island's command bar (show + focus + open the palette so you can
// type into the island). The desktop writes it from its Island settings; the
// island (a separate Electron process that cannot share the desktop's
// localStorage) reads it on startup, subscribes to changes, and re-registers the
// global accelerator live.
//
// Stored as a bare Electron accelerator string (e.g. "CommandOrControl+Shift+Space"),
// mirroring the other bare-scalar island prefs (not a JSON blob). Like every Ryu
// default, the shortcut is swappable, never a lock.

/** Preference key shared with the desktop's preferences client + Core KV store. */
export const COMMAND_SHORTCUT_PREF_KEY = "island-command-shortcut";

/**
 * Default summon accelerator. Matches the companion's historical hotkey so
 * existing muscle memory keeps working; stays rebindable in Island settings.
 */
export const DEFAULT_COMMAND_SHORTCUT = "CommandOrControl+Shift+Space";

/**
 * Tolerantly coerce a raw preference value (a bare accelerator string from Core,
 * or `null`) into a valid accelerator. Falls back to
 * {@link DEFAULT_COMMAND_SHORTCUT} for any missing/blank value so a malformed
 * blob never leaves the command bar unsummonable.
 */
export function parseCommandShortcut(raw: string | null): string {
	if (raw === null) {
		return DEFAULT_COMMAND_SHORTCUT;
	}
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : DEFAULT_COMMAND_SHORTCUT;
}
