// Island appearance preference: the cross-process contract persisted in Core
// under the `island-appearance` key. The desktop writes it from its Appearance
// settings; the island companion (a separate Electron process that cannot share
// the desktop's localStorage) reads it on startup and reconfigures its window.
//
// Two backgrounds, both swappable defaults (never a lock), per the Ryu rule:
//   - `translucent`: the oversized transparent window + a semi-transparent,
//     CSS-blurred shape. Works everywhere; keeps the fluid split-morph. This is
//     a tinted glass look, not a true desktop blur (CSS `backdrop-filter` cannot
//     reach the desktop behind a transparent Electron window).
//   - `acrylic`: a native OS material — Windows 11 acrylic (`backgroundMaterial`)
//     or macOS vibrancy (`vibrancy`) — that truly blurs the desktop. The window
//     tracks the island footprint because native materials fill the whole window
//     rectangle, so the morph becomes a size-snap rather than a fluid spring.

/** Preference key shared with the desktop's preferences client + Core KV store. */
export const APPEARANCE_PREF_KEY = "island-appearance";

/**
 * The island background treatment:
 * - `translucent`: transparent window + CSS dark tint. The floating split shape;
 *   no real desktop blur (CSS can't reach behind a transparent window).
 * - `acrylic`: Electron's built-in native material (`backgroundMaterial: "acrylic"`
 *   on Win11, `vibrancy` on macOS). Real desktop blur, but a rectangular window.
 * - `mica`: like `acrylic` but on Windows uses the `mica-electron` native module
 *   for the nicer Win11 Mica / Acrylic materials. On macOS there is no Mica, so it
 *   falls back to the same `vibrancy` as `acrylic` (macOS's native equivalent).
 *   Also a rectangular window.
 */
export type IslandBackground = "translucent" | "acrylic" | "mica";

/**
 * Whether an appearance uses a native OS material (a content-tracked, rectangular
 * window that truly blurs the desktop). Both `acrylic` and `mica` do; only
 * `translucent` keeps the floating transparent split shape.
 */
export function isMaterialAppearance(bg: IslandBackground): boolean {
	return bg === "acrylic" || bg === "mica";
}

/** The full appearance blob persisted under {@link APPEARANCE_PREF_KEY}. */
export interface IslandAppearance {
	background: IslandBackground;
}

/**
 * Default appearance: `translucent` — the floating split-island look (an oversized
 * transparent window; only the rounded shapes are painted, the rest is
 * click-through). `acrylic` is still selectable in desktop Settings → Appearance
 * and is the ONLY mode that truly blurs the desktop (native OS material), BUT that
 * material fills the whole rectangular window — it can't be clipped to the rounded
 * shapes or leave the split gap transparent — so acrylic shows as a frosted
 * RECTANGLE, not a floating island. Translucent can't blur the desktop (CSS
 * `backdrop-filter` can't reach behind a transparent window) but keeps the shape,
 * so it is the right default for this split-island design.
 */
export const DEFAULT_APPEARANCE: IslandAppearance = {
	background: "translucent",
};

/**
 * Tolerantly coerce a raw preference value (JSON string from Core, or `null`)
 * into an {@link IslandAppearance}. Falls back to the default for any
 * missing/unknown field so a malformed blob never breaks window creation.
 */
export function parseAppearance(raw: string | null): IslandAppearance {
	if (!raw) {
		return DEFAULT_APPEARANCE;
	}
	try {
		const parsed = JSON.parse(raw) as { background?: unknown };
		let background: IslandBackground = "translucent";
		if (parsed.background === "acrylic") {
			background = "acrylic";
		} else if (parsed.background === "mica") {
			background = "mica";
		}
		return { background };
	} catch {
		return DEFAULT_APPEARANCE;
	}
}
