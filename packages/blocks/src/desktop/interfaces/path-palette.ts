import type { CSSProperties } from "react";

/**
 * Path art: the colours of the trail diorama (stepping stones, the dirt
 * trail, signposts, lanterns and the goal flag) and the one theme-mixed unit
 * tone the plain list uses. Game art is allowed its own palette (this is the
 * one file in the Path where literal colours live); the HUD comes from the
 * game kit, and the open thread's body stays on the theme.
 */

/**
 * The teal unit colour: the theme's success and info roles mixed, at a fixed
 * lightness and a floor under its chroma, so a teal unit reads the same in
 * light and dark themes (white text on a mid teal) instead of flipping from
 * dark to pale. A lighter teal carries text on night plates.
 */
const UNIT_TEAL = {
	"--path-teal":
		"oklch(from color-mix(in oklch, var(--success) 55%, var(--info)) 0.54 clamp(0.1, c, 0.15) h)",
	"--path-teal-ink-d":
		"oklch(from color-mix(in oklch, var(--success) 55%, var(--info)) 0.8 clamp(0.1, c, 0.14) h)",
	"--path-teal-ink-l":
		"oklch(from color-mix(in oklch, var(--success) 55%, var(--info)) 0.46 clamp(0.1, c, 0.15) h)",
};

/** Inline custom properties for the interface root. */
export const PATH_SCENE_VARS = UNIT_TEAL as CSSProperties;

/** Picks the day or night teal ink, so the list uses the plain name. */
export const PATH_SCENE_MODE =
	"[--path-teal-ink:var(--path-teal-ink-l)] dark:[--path-teal-ink:var(--path-teal-ink-d)]";

/** The diorama's colours (linear-light conversion happens in the kit). */
export const PATH_3D = {
	/** The dirt trail, by day and by night. */
	trail: "#b98a52",
	trailNight: "#6a5a62",
	/** Stepping stones: the stone body under each coloured top. */
	stone: "#d8d2c4",
	stoneNight: "#8a8798",
	stoneSide: "#a69f90",
	/** Stone tops by stop state. */
	done: "#ffcf4d",
	current: "#ffa23a",
	reply: "#5aa6ff",
	attention: "#ef4f43",
	working: "#56c271",
	waiting: "#b9b4a8",
	fresh: "#cfc9bb",
	/** Moss on the grey stones that wait. */
	moss: "#6f9a4a",
	/** Lanterns on finished stones: post, cap and the lit glass. */
	lanternPost: "#4d3b30",
	lanternGlow: "#ffe08a",
	/** Signposts: post and the board, by unit (cycled). */
	signPost: "#8a5f3d",
	signBoards: ["#e8b55a", "#7cc1d9", "#e88d7a", "#9ccf7c"],
	/** The goal flag. */
	flagPole: "#efe7d6",
	flag: "#ef5a43",
	flagBase: "#b8ad98",
} as const;

/** The plan's pips as pebbles round a stop: laid, the estimate's, to come. */
export const PATH_PIP_SKIN = {
	done: PATH_3D.done,
	estimate: PATH_3D.current,
	todo: PATH_3D.stoneSide,
} as const;

/** The torch that burns down beside a queued hiker. */
export const PATH_TIMER_SKIN = { color: PATH_3D.current } as const;
