// Shared auto-update preference: the cross-surface contract persisted in Core
// under the `auto-updates` key. The desktop reads/writes the SAME key from its
// own settings, so the island companion (a separate Electron process) reads and
// writes this key too — the toggle is shared across every Ryu surface.
//
// The value is the JSON blob `{ "enabled": boolean }`. When the key is unset
// (Core returns 404), auto-updates default to ENABLED, matching the desktop.

/** Preference key shared with the desktop + Core KV store (Core's `AUTO_UPDATE_PREF_KEY`). */
export const AUTO_UPDATE_PREF_KEY = "auto-updates";

/** The full auto-update blob persisted under {@link AUTO_UPDATE_PREF_KEY}. */
export interface AutoUpdatePref {
	enabled: boolean;
}

/** Default: auto-updates ON (matches the desktop's default-when-unset behaviour). */
export const DEFAULT_AUTO_UPDATE: AutoUpdatePref = {
	enabled: true,
};

/**
 * Tolerantly coerce a raw preference value (JSON string from Core, or `null`)
 * into an {@link AutoUpdatePref}. A missing key, malformed blob, or non-boolean
 * `enabled` falls back to the enabled default so a bad value never silently
 * disables updates.
 */
export function parseAutoUpdate(raw: string | null): AutoUpdatePref {
	if (!raw) {
		return DEFAULT_AUTO_UPDATE;
	}
	try {
		const parsed = JSON.parse(raw) as { enabled?: unknown };
		return { enabled: parsed.enabled !== false };
	} catch {
		return DEFAULT_AUTO_UPDATE;
	}
}

/** Serialize an {@link AutoUpdatePref} to the JSON string Core stores as the value. */
export function serializeAutoUpdate(pref: AutoUpdatePref): string {
	return JSON.stringify({ enabled: pref.enabled });
}
