import { z } from "zod";
// Island appearance preference: the cross-process contract persisted in Core
// under the `island-appearance` key. The desktop writes it from its Appearance
// settings; the island companion (a separate Electron process that cannot share
// the desktop's localStorage) reads it on startup and reconfigures its window.
//
// Three backgrounds remain user-selectable:
//   - `translucent`: the oversized transparent window + a semi-transparent,
//     CSS-blurred shape. Works everywhere; keeps the fluid split-morph. This is
//     a tinted glass look, not a true desktop blur (CSS `backdrop-filter` cannot
//     reach the desktop behind a transparent Electron window).
//   - `acrylic`: a native OS material — Windows 11 acrylic (`backgroundMaterial`)
//     or macOS vibrancy (`vibrancy`) — that truly blurs the desktop. Its window
//     tracks the visible Island footprint so the backdrop stays with the surface.
//   - `mica`: the Windows 11 Mica/Acrylic material through `mica-electron`,
//     falling back to the built-in Acrylic material on other systems.

/** Preference key shared with the desktop's preferences client + Core KV store. */
export const APPEARANCE_PREF_KEY = "island-appearance";

/**
 * Every background value Desktop Settings writes. The type and the parser both
 * derive from this list, so the Island accepts exactly the values it names.
 */
export const ISLAND_BACKGROUNDS = ["translucent", "acrylic", "mica"] as const;

/**
 * The island background treatment:
 * - `translucent`: transparent window + CSS dark tint. The floating split shape;
 *   no real desktop blur (CSS can't reach behind a transparent window).
 * - `acrylic`: Electron's built-in native material (`backgroundMaterial: "acrylic"`
 *   on Win11, `vibrancy` on macOS). A native mask keeps the split gap clear.
 * - `mica`: like `acrylic` but on Windows uses the `mica-electron` native module
 *   for the nicer Win11 Mica / Acrylic materials. On macOS there is no Mica, so it
 *   falls back to the same `vibrancy` as `acrylic` (macOS's native equivalent).
 *   The same shape mask keeps the surrounding window transparent.
 */
export type IslandBackground = (typeof ISLAND_BACKGROUNDS)[number];

/**
 * Whether an appearance uses a native OS material (a content-tracked window
 * whose backdrop is clipped to visible shapes). Both `acrylic` and `mica` do; only
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
 * Default appearance: `acrylic` — a content-tracked transparent window with native
 * OS material, so the desktop behind the Island is visibly blurred. Translucent
 * remains selectable in desktop Settings → Appearance for the floating split
 * shape; its CSS backdrop filter cannot reach other desktop windows.
 */
export const DEFAULT_APPEARANCE: IslandAppearance = {
	background: "acrylic",
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
		return z
			.object({
				background: z
					.enum(ISLAND_BACKGROUNDS)
					.catch(DEFAULT_APPEARANCE.background),
			})
			.catch(DEFAULT_APPEARANCE)
			.parse(JSON.parse(raw));
	} catch {
		return DEFAULT_APPEARANCE;
	}
}
