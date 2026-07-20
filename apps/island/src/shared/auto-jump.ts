// Island auto-jump preference: the cross-process contract persisted in Core under
// the `island-auto-jump` key. When enabled, the island companion follows the user
// to whichever desktop/monitor they are active on (the one under the cursor),
// re-docking to the same zone on the new display. The desktop writes it from its
// Island settings; the island (a separate Electron process that cannot share the
// desktop's localStorage) reads it on startup and subscribes to changes.
//
// Stored as a bare boolean string ("true"/"false"), mirroring the edge-offset
// preference's bare-scalar shape (not a JSON blob).

/** Preference key shared with the desktop's preferences client + Core KV store. */
export const AUTO_JUMP_PREF_KEY = "island-auto-jump";

/** Default: off, so the island stays put until the user opts in. */
export const DEFAULT_AUTO_JUMP = false;

/**
 * Tolerantly coerce a raw preference value (a bare boolean string from Core, or
 * `null`) into the auto-jump flag. Falls back to {@link DEFAULT_AUTO_JUMP} for any
 * missing/unrecognized value so a malformed blob never changes the behavior.
 */
export function parseAutoJump(raw: string | null): boolean {
	if (raw === null) {
		return DEFAULT_AUTO_JUMP;
	}
	const value = raw.trim().toLowerCase();
	if (value === "true" || value === "1") {
		return true;
	}
	if (value === "false" || value === "0") {
		return false;
	}
	return DEFAULT_AUTO_JUMP;
}
