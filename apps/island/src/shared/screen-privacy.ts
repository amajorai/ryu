// Island screen-privacy preference: the cross-process contract persisted in Core
// under the `island-screen-privacy` key. When enabled, the island window is
// excluded from screen capture — it stays visible to the user on their physical
// display but is omitted from screenshots, screen recordings, and screen-sharing
// (meetings, Cluely/Pluely-style capture). Implemented with Electron's built-in
// `BrowserWindow.setContentProtection`, which maps to `WDA_EXCLUDEFROMCAPTURE`
// on Windows 10 2004+ and `NSWindowSharingNone` on macOS. The desktop writes it
// from its Island settings; the island (a separate Electron process that cannot
// share the desktop's localStorage) reads it on startup and subscribes to
// changes.
//
// Stored as a bare boolean string ("true"/"false"), mirroring the auto-jump
// preference's bare-scalar shape (not a JSON blob).

/** Preference key shared with the desktop's preferences client + Core KV store. */
export const SCREEN_PRIVACY_PREF_KEY = "island-screen-privacy";

/**
 * Default: on. The island is excluded from screen capture unless the user opts
 * out, matching the "hidden by default" intent of the feature.
 */
export const DEFAULT_SCREEN_PRIVACY = true;

/**
 * Tolerantly coerce a raw preference value (a bare boolean string from Core, or
 * `null`) into the screen-privacy flag. Falls back to
 * {@link DEFAULT_SCREEN_PRIVACY} for any missing/unrecognized value so a
 * malformed blob never changes the behavior.
 */
export function parseScreenPrivacy(raw: string | null): boolean {
	if (raw === null) {
		return DEFAULT_SCREEN_PRIVACY;
	}
	const value = raw.trim().toLowerCase();
	if (value === "true" || value === "1") {
		return true;
	}
	if (value === "false" || value === "0") {
		return false;
	}
	return DEFAULT_SCREEN_PRIVACY;
}
