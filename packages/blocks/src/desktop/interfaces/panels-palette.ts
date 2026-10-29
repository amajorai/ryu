import type { SkyPhase } from "./panels-model.ts";

/**
 * Art palette for the Home sky. These are scenery colors, not chrome: the sky
 * component mixes every stop into the theme's own `--background`, so the band
 * always fades into the user's theme and text on it keeps the theme contrast.
 */
export interface SkyPalette {
	/** Glow around the sun or moon. */
	halo: string;
	/** Low sky, just above where the band fades into the page. */
	horizon: string;
	/** The disc itself. */
	light: string;
	/** Mid sky. */
	middle: string;
	/** Share of the art color in each mixed stop, 0 to 100. */
	strength: number;
	/** High sky, at the top of the band. */
	zenith: string;
}

export const SKY_PALETTES: Record<SkyPhase, SkyPalette> = {
	dawn: {
		halo: "#ffc58f",
		horizon: "#f6c6a8",
		light: "#ffe2b8",
		middle: "#c9b8d8",
		strength: 46,
		zenith: "#7f97c9",
	},
	day: {
		halo: "#fff1c4",
		horizon: "#cfe6f5",
		light: "#fff6d8",
		middle: "#9fcbec",
		strength: 54,
		zenith: "#5e9fd8",
	},
	dusk: {
		halo: "#ff9e6e",
		horizon: "#f2a983",
		light: "#ffd2a6",
		middle: "#a98bb8",
		strength: 48,
		zenith: "#4b4f86",
	},
	night: {
		halo: "#c9d2ff",
		horizon: "#6f7fd6",
		light: "#eef1ff",
		middle: "#3446a8",
		strength: 44,
		zenith: "#16207a",
	},
};

/** Star color for the night and late dusk sky. */
export const SKY_STAR = "#f4f6ff";
