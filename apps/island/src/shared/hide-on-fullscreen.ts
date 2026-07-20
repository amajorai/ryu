// Island hide-on-fullscreen preference: the cross-process contract persisted in
// Core under the `island-hide-on-fullscreen` key. When enabled, the island
// companion hides itself while another app is running fullscreen (a fullscreen
// video, a game, a presentation) so it never floats over content the user is
// immersed in, and reappears the moment the fullscreen app exits. The desktop
// writes it from its Island settings; the island (a separate Electron process
// that cannot share the desktop's localStorage) reads it on startup and
// subscribes to changes.
//
// Detection is Windows-only for now (the island main polls the Win32
// `SHQueryUserNotificationState` shell signal — see `main/fullscreen.ts`); on
// macOS/Linux the preference is accepted and stored but currently has no effect.
//
// Stored as a bare boolean string ("true"/"false"), mirroring the auto-jump
// preference's bare-scalar shape (not a JSON blob).

/** Preference key shared with the desktop's preferences client + Core KV store. */
export const HIDE_ON_FULLSCREEN_PREF_KEY = "island-hide-on-fullscreen";

/**
 * Default: on. The island stays out of the way of fullscreen content unless the
 * user opts out, matching the "hidden by default" intent of the feature.
 */
export const DEFAULT_HIDE_ON_FULLSCREEN = true;

/**
 * Tolerantly coerce a raw preference value (a bare boolean string from Core, or
 * `null`) into the hide-on-fullscreen flag. Falls back to
 * {@link DEFAULT_HIDE_ON_FULLSCREEN} for any missing/unrecognized value so a
 * malformed blob never changes the behavior.
 */
export function parseHideOnFullscreen(raw: string | null): boolean {
	if (raw === null) {
		return DEFAULT_HIDE_ON_FULLSCREEN;
	}
	const value = raw.trim().toLowerCase();
	if (value === "true" || value === "1") {
		return true;
	}
	if (value === "false" || value === "0") {
		return false;
	}
	return DEFAULT_HIDE_ON_FULLSCREEN;
}
