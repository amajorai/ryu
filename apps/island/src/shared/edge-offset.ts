// Island edge-offset preference: the cross-process contract persisted in Core
// under the `island-edge-offset` key. The desktop writes it from its Appearance
// settings; the island companion (a separate Electron process that cannot share
// the desktop's localStorage) reads it on startup, subscribes to changes, and
// uses it as the gap between the island and whichever screen edge it docks to.
//
// One scalar, applied per-axis: docking to the top/bottom edge insets vertically,
// the left/right edge insets horizontally, and a corner insets on both axes at
// once (the "diagonal" case). A single value keeps it swappable, never a lock.

/** Preference key shared with the desktop's preferences client + Core KV store. */
export const EDGE_OFFSET_PREF_KEY = "island-edge-offset";

/**
 * Default gap from a screen edge, in pixels. macOS docks flush against the edge
 * (0) to sit under the notch/menu bar like a native affordance; other platforms
 * inset by 20. Safe to read `process.platform` here — this module is only ever
 * imported by the island's Electron main process.
 */
export const DEFAULT_EDGE_OFFSET = process.platform === "darwin" ? 0 : 20;

/** Smallest allowed offset (flush against the edge). */
export const MIN_EDGE_OFFSET = 0;

/** Largest allowed offset; the snap math also clamps to keep the island on-screen. */
export const MAX_EDGE_OFFSET = 96;

/** Clamp an arbitrary number into the supported, whole-pixel offset range. */
export function clampEdgeOffset(value: number): number {
	return Math.min(
		MAX_EDGE_OFFSET,
		Math.max(MIN_EDGE_OFFSET, Math.round(value))
	);
}

/**
 * Tolerantly coerce a raw preference value (a bare number string from Core, or
 * `null`) into a valid edge offset. Falls back to {@link DEFAULT_EDGE_OFFSET}
 * for any missing/non-numeric value so a malformed blob never breaks the layout.
 */
export function parseEdgeOffset(raw: string | null): number {
	if (raw === null) {
		return DEFAULT_EDGE_OFFSET;
	}
	const value = Number(raw.trim());
	if (!Number.isFinite(value)) {
		return DEFAULT_EDGE_OFFSET;
	}
	return clampEdgeOffset(value);
}
