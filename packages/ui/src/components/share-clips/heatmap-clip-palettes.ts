/**
 * Colour palettes for the contributions-heatmap clip (`./heatmap-clip.ts`).
 */

import type { HeatmapClipPalette } from "./heatmap-clip-types.ts";

export const HEATMAP_CLIP_PALETTES = {
	dark: {
		background: "#09090b",
		empty: "#18181b",
		foreground: "#fafafa",
		levels: ["#064e3b", "#047857", "#10b981", "#34d399"],
		muted: "#a1a1aa",
	},
	light: {
		background: "#ffffff",
		empty: "#f4f4f5",
		foreground: "#09090b",
		levels: ["#a7f3d0", "#6ee7b7", "#34d399", "#10b981"],
		muted: "#71717a",
	},
} as const satisfies Record<"dark" | "light", HeatmapClipPalette>;
