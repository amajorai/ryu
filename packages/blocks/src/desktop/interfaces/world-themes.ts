import type { WorldTheme } from "@ryuhq/protocol/interfaces";
import type { VillageLayout } from "./world-village.ts";

/** One canopy shade set; trees pick one of three per tile so forests vary. */
export interface CanopyTone {
	dark: string;
	glint: string;
	light: string;
	mid: string;
}

/**
 * Pixel-art scene colors for one world theme. The 2D village draws every
 * tile from these; the 3D world may reuse them so both read as one place.
 */
export interface WorldScenePalette {
	/** Multiply tint laid over the whole scene (night), or null. */
	ambient: string | null;
	/** Fill beyond the walkable world: forest floor outdoors, the dark beyond the walls indoors. */
	edge: string;
	/** Visible fireflies drifting over the grass (night). */
	fireflies: boolean;
	/** Tiny 4-petal flower colors. */
	flowers: readonly string[];
	/**
	 * Ground tones picked per 2x2 tile cluster (outdoor grass) or used as plank
	 * shades (indoor wood floor), plus tuft colors.
	 */
	grass: readonly [string, string, string];
	grassDetail: string;
	grassLight: string;
	house: {
		door: string;
		doorDark: string;
		foundation: string;
		glass: string;
		glassLit: string;
		/** Halo around a lit window. */
		glow: string;
		outline: string;
		/** Multipliers applied to the curated roof palette (1 keeps it as is). */
		roofLightness: number;
		roofSaturation: number;
		timber: string;
		timberDark: string;
		wall: string;
		wallLine: string;
	};
	/** Indoor themes draw cubicles, rugs and potted plants instead. */
	kind: "indoor" | "outdoor";
	lamp: { glow: string; light: string; lit: boolean; post: string };
	/** Stone street (outdoor) or rug (indoor) tiles. */
	path: {
		edge: string;
		fill: string;
		light: string;
		pebble: string;
		/** Embedded flagstones. */
		stone: string;
		stoneDark: string;
		/** Darker worn band just inside the edge. */
		worn: string;
	};
	/** Cobblestone plaza (outdoor) or polished lobby stone (indoor). */
	plaza: { fill: string; gap: string; light: string; shade: string };
	/** Stone of wells, rocks and the plaza props. */
	rock: { dark: string; fill: string; light: string };
	shadow: string;
	sign: { text: string; wood: string; woodDark: string };
	/** Typing bubble over a working agent. */
	speech: { bubble: string; dot: string; outline: string };
	tree: {
		/** Three canopy shade sets, chosen per tree by hash. */
		canopy: readonly [CanopyTone, CanopyTone, CanopyTone];
		dark: string;
		/** Blossoms or fruit on the flowering variant. */
		fruit: string;
		glint: string;
		light: string;
		mid: string;
		outline: string;
		trunk: string;
		trunkDark: string;
	};
	/** Darkening toward the viewport edges, or null. */
	vignette: string | null;
	/** Indoor only: the wall band around the room. */
	wall: { base: string; face: string; trim: string };
}

/**
 * Colors of the RPG dialog panel (talk panel). Each theme frames the panel so
 * it belongs to the world instead of floating over it as a plain sheet.
 */
export interface WorldDialogPalette {
	/** Accent for the speaker's name and the list cursor. */
	accent: string;
	/** 1px inner bevel just inside the frame. */
	bevel: string;
	border: string;
	/** Dotted dividers between list rows. */
	divider: string;
	fill: string;
	/** Focus ring that reads on this fill. */
	focus: string;
	/** Header band behind the portrait. */
	header: string;
	/** Row hover / selected fill. */
	hover: string;
	muted: string;
	/** The speech box holding the agent's line. */
	speech: string;
	text: string;
	/** Inset well for the composer and the open thread. */
	well: string;
	wellBorder: string;
	/** Status color for a working agent. */
	working: string;
}

export interface WorldPalette {
	/** Decorations (trees, plants, lamps). */
	accent: string;
	/** The talk panel frame. */
	dialog: WorldDialogPalette;
	ground: string;
	groundAlt: string;
	/** The plaza row the player spawns on. */
	path: string;
	/** Curated roof (or cubicle panel) colors, assigned per house in order. */
	roofs: readonly string[];
	/** Detailed pixel-art scene colors. */
	scene: WorldScenePalette;
	/** Readable label color on top of the ground. */
	text: string;
}

/**
 * Muted, earthy roof colors (brick, slate, mustard, teal, plum, coral, moss,
 * charcoal) in the order houses receive them, so neighbors never match until
 * the palette runs out.
 */
const ROOF_PALETTE = [
	"#b5523b",
	"#4f6d8f",
	"#c99a2e",
	"#3e8a86",
	"#7d4e7a",
	"#d0745a",
	"#6b8f3e",
	"#4a4f57",
] as const;

const MEADOW_SCENE: WorldScenePalette = {
	ambient: null,
	edge: "#3f7d33",
	fireflies: false,
	flowers: ["#ff6b8b", "#ffd23f", "#ffffff", "#b58cff", "#ff9a3d"],
	grass: ["#7cc653", "#77c04e", "#81cb59"],
	grassDetail: "#5a9e3a",
	grassLight: "#a2e072",
	house: {
		door: "#9a6237",
		doorDark: "#5f3a1e",
		foundation: "#a59c8d",
		glass: "#4e6f93",
		glassLit: "#ffd76e",
		glow: "rgba(255, 205, 110, 0.55)",
		outline: "#4a2e1a",
		roofLightness: 1,
		roofSaturation: 1,
		timber: "#8f5d36",
		timberDark: "#5f3a1e",
		wall: "#f4e4c1",
		wallLine: "#dcc59b",
	},
	kind: "outdoor",
	lamp: {
		glow: "rgba(255, 214, 140, 0)",
		light: "#fff3c4",
		lit: false,
		post: "#3c3a48",
	},
	path: {
		edge: "#a9814f",
		fill: "#e3c995",
		light: "#f1dcb1",
		pebble: "#c6a673",
		stone: "#d8d0c0",
		stoneDark: "#8f8576",
		worn: "#cfb27c",
	},
	plaza: {
		fill: "#d9cdb4",
		gap: "#a89a82",
		light: "#efe7d4",
		shade: "#c6b89d",
	},
	rock: { dark: "#6f6a62", fill: "#a8a399", light: "#cfcac0" },
	shadow: "rgba(24, 48, 12, 0.28)",
	sign: { text: "#fdf3d8", wood: "#9a6237", woodDark: "#5f3a1e" },
	speech: { bubble: "#ffffff", dot: "#374151", outline: "#1f2937" },
	tree: {
		canopy: [
			{ dark: "#2c6a2b", glint: "#9ad870", light: "#5aab45", mid: "#3f8c36" },
			{ dark: "#245f36", glint: "#8fd09a", light: "#4c9d5c", mid: "#337f47" },
			{ dark: "#3b6a22", glint: "#b4da6c", light: "#76ab3f", mid: "#548b2e" },
		],
		dark: "#2c6a2b",
		fruit: "#ff8fb4",
		glint: "#9ad870",
		light: "#5aab45",
		mid: "#3f8c36",
		outline: "#1c4419",
		trunk: "#7c4c2a",
		trunkDark: "#52321b",
	},
	vignette: "rgba(30, 60, 10, 0.18)",
	wall: { base: "#3f7d33", face: "#3f7d33", trim: "#3f7d33" },
};

const NIGHT_SCENE: WorldScenePalette = {
	ambient: "rgba(34, 44, 140, 0.36)",
	edge: "#0f1d27",
	fireflies: true,
	flowers: ["#c1b0ff", "#8fd6ff", "#f2e9ff", "#ffa6cf"],
	// One base tone: at night only tufts and flowers carry the detail.
	grass: ["#2d4a56", "#2d4a56", "#2d4a56"],
	grassDetail: "#1f3740",
	grassLight: "#46706f",
	house: {
		door: "#5a4152",
		doorDark: "#2f2232",
		foundation: "#555a70",
		glass: "#24304d",
		glassLit: "#ffcf6e",
		glow: "rgba(255, 190, 90, 0.6)",
		outline: "#170f20",
		roofLightness: 0.75,
		roofSaturation: 0.7,
		timber: "#4f3d4c",
		timberDark: "#2e2333",
		wall: "#9d98b4",
		wallLine: "#807b9a",
	},
	kind: "outdoor",
	lamp: {
		glow: "rgba(255, 196, 110, 0.5)",
		light: "#ffe2a0",
		lit: true,
		post: "#1d1c28",
	},
	path: {
		edge: "#3d3f57",
		fill: "#71728a",
		light: "#8d8ea6",
		pebble: "#5c5d75",
		stone: "#8f91a8",
		stoneDark: "#44465e",
		worn: "#64657d",
	},
	plaza: {
		fill: "#686b83",
		gap: "#43455c",
		light: "#8487a0",
		shade: "#5a5d74",
	},
	rock: { dark: "#3a3d52", fill: "#62667e", light: "#8689a2" },
	shadow: "rgba(4, 8, 24, 0.4)",
	sign: { text: "#f4e9cf", wood: "#5a4152", woodDark: "#2f2232" },
	speech: { bubble: "#e5e7eb", dot: "#1f2937", outline: "#0b1020" },
	tree: {
		canopy: [
			{ dark: "#14302e", glint: "#4a7c72", light: "#2b5650", mid: "#1f423e" },
			{ dark: "#122a33", glint: "#477488", light: "#285060", mid: "#1c3c47" },
			{ dark: "#1a2f28", glint: "#5a7f6c", light: "#36584a", mid: "#284437" },
		],
		dark: "#14302e",
		fruit: "#cbbcff",
		glint: "#4a7c72",
		light: "#2b5650",
		mid: "#1f423e",
		outline: "#08181a",
		trunk: "#3f2d2b",
		trunkDark: "#26191a",
	},
	vignette: "rgba(3, 6, 26, 0.62)",
	wall: { base: "#0f1d27", face: "#0f1d27", trim: "#0f1d27" },
};

const OFFICE_SCENE: WorldScenePalette = {
	ambient: null,
	edge: "#23262e",
	fireflies: false,
	flowers: ["#e86a5c", "#f2c14e", "#6aa7e8"],
	// Plank shades of one continuous oak floor.
	grass: ["#d6b383", "#cfab7a", "#dcbb8d"],
	grassDetail: "#a9824f",
	grassLight: "#ead0a6",
	house: {
		door: "#6f8fb8",
		doorDark: "#3f5b80",
		foundation: "#8d8a96",
		glass: "#2b3448",
		glassLit: "#9fe3ff",
		glow: "rgba(130, 210, 255, 0.5)",
		outline: "#2e2a38",
		roofLightness: 1.32,
		roofSaturation: 0.55,
		timber: "#8f8a99",
		timberDark: "#5e5a68",
		wall: "#e9e6ef",
		wallLine: "#cfcad8",
	},
	kind: "indoor",
	lamp: {
		glow: "rgba(255, 240, 200, 0)",
		light: "#fff6d8",
		lit: false,
		post: "#3a3744",
	},
	path: {
		edge: "#3f5c85",
		fill: "#6f8fb8",
		light: "#8eaad0",
		pebble: "#5d7ca6",
		stone: "#8eaad0",
		stoneDark: "#4d6b94",
		worn: "#6687b0",
	},
	plaza: {
		fill: "#ece8e1",
		gap: "#c9c2b5",
		light: "#f8f6f2",
		shade: "#e3ded5",
	},
	rock: { dark: "#6d6f78", fill: "#b9bcc4", light: "#dfe1e6" },
	shadow: "rgba(40, 30, 20, 0.22)",
	sign: { text: "#fdfaf2", wood: "#4b4558", woodDark: "#2e2a38" },
	speech: { bubble: "#ffffff", dot: "#374151", outline: "#1f2937" },
	tree: {
		canopy: [
			{ dark: "#2f6b3a", glint: "#8fd08a", light: "#57a35a", mid: "#3f8a47" },
			{ dark: "#2a6146", glint: "#86c9a0", light: "#4f9a6a", mid: "#387f55" },
			{ dark: "#3a6b30", glint: "#a6d47c", light: "#6aa54c", mid: "#4f8a3c" },
		],
		dark: "#2f6b3a",
		fruit: "#f2c14e",
		glint: "#8fd08a",
		light: "#57a35a",
		mid: "#3f8a47",
		outline: "#1e4426",
		trunk: "#c0653e",
		trunkDark: "#8a4428",
	},
	vignette: "rgba(10, 10, 16, 0.5)",
	wall: { base: "#3a3f4b", face: "#4a505e", trim: "#2a2e37" },
};

const PARCHMENT_DIALOG: WorldDialogPalette = {
	accent: "#a4471f",
	bevel: "#e9d4a6",
	border: "#5b3a21",
	divider: "#b89a6c",
	fill: "#f4e8cc",
	focus: "#c25d1d",
	header: "#ead9b1",
	hover: "#ead8ae",
	muted: "#7a5a3a",
	speech: "#fffaf0",
	text: "#3b2614",
	well: "#fffaf0",
	wellBorder: "#5b3a21",
	working: "#3f7d23",
};

const MOONLIT_DIALOG: WorldDialogPalette = {
	accent: "#ffd25e",
	bevel: "#2c3655",
	border: "#c9d3f0",
	divider: "#4a5578",
	fill: "#1b2238",
	focus: "#ffd25e",
	header: "#151b2e",
	hover: "#253052",
	muted: "#9aa6c8",
	speech: "#232c47",
	text: "#e8ecf8",
	well: "#121829",
	wellBorder: "#0a0e1a",
	working: "#8fe07a",
};

const OFFICE_DIALOG: WorldDialogPalette = {
	accent: "#3f5c85",
	bevel: "#ffffff",
	border: "#3a3f4b",
	divider: "#b8bcc6",
	fill: "#f1efea",
	focus: "#3f6fd8",
	header: "#e4e1da",
	hover: "#e6e3dc",
	muted: "#5f6470",
	speech: "#ffffff",
	text: "#23262e",
	well: "#ffffff",
	wellBorder: "#3a3f4b",
	working: "#2f7d3b",
};

/** World palettes are scene colors, not UI chrome, so they are fixed per theme. */
export const WORLD_PALETTES: Record<WorldTheme, WorldPalette> = {
	meadow: {
		accent: "#2f7d46",
		dialog: PARCHMENT_DIALOG,
		ground: "#8fcf7a",
		groundAlt: "#84c46f",
		path: "#e8d9a8",
		roofs: ROOF_PALETTE,
		scene: MEADOW_SCENE,
		text: "#14301c",
	},
	night: {
		accent: "#7c83ff",
		dialog: MOONLIT_DIALOG,
		ground: "#1f2547",
		groundAlt: "#1b2140",
		path: "#3a3f6b",
		roofs: ROOF_PALETTE,
		scene: NIGHT_SCENE,
		text: "#e6e8ff",
	},
	office: {
		accent: "#8a6f4d",
		dialog: OFFICE_DIALOG,
		ground: "#e9e4dc",
		groundAlt: "#e2dcd2",
		path: "#cfc6b8",
		roofs: ROOF_PALETTE,
		scene: OFFICE_SCENE,
		text: "#2b2620",
	},
};

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

interface Hsl {
	h: number;
	l: number;
	s: number;
}

function hexToHsl(hex: string): Hsl {
	const value = Number.parseInt(hex.replace("#", ""), 16);
	const r = ((value >> 16) & 255) / 255;
	const g = ((value >> 8) & 255) / 255;
	const b = (value & 255) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) {
		return { h: 0, l: l * 100, s: 0 };
	}
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	if (max === r) {
		h = (g - b) / d + (g < b ? 6 : 0);
	} else if (max === g) {
		h = (b - r) / d + 2;
	} else {
		h = (r - g) / d + 4;
	}
	return { h: h * 60, l: l * 100, s: s * 100 };
}

function hslString({ h, l, s }: Hsl): string {
	const clamp = (value: number) => Math.min(100, Math.max(0, value));
	return `hsl(${Math.round(h)} ${clamp(s).toFixed(1)}% ${clamp(l).toFixed(1)}%)`;
}

/** Shift a hex color's HSL lightness by `delta` percentage points. */
export function shiftLightness(hex: string, delta: number): string {
	const hsl = hexToHsl(hex);
	return hslString({ ...hsl, l: hsl.l + delta });
}

export interface RoofTones {
	/** Eaves shadow and shingle lines: 18% darker. */
	dark: string;
	fill: string;
	/** Back slope catching the light: 6% lighter. */
	light: string;
	/** Ridge highlight: 12% lighter. */
	ridge: string;
}

/**
 * Roof (or cubicle panel) tones from a curated palette color, adjusted for
 * the theme (night desaturates and darkens the same palette).
 */
export function roofTones(base: string, scene: WorldScenePalette): RoofTones {
	const hsl = hexToHsl(base);
	const tuned: Hsl = {
		h: hsl.h,
		l: hsl.l * scene.house.roofLightness,
		s: hsl.s * scene.house.roofSaturation,
	};
	return {
		dark: hslString({ ...tuned, l: tuned.l - 18 }),
		fill: hslString(tuned),
		light: hslString({ ...tuned, l: tuned.l + 6 }),
		ridge: hslString({ ...tuned, l: tuned.l + 12 }),
	};
}

/**
 * Each house's roof color, assigned in village order from the curated
 * palette so no two houses share one until the palette runs out. Use the
 * agent's hue for the agent itself (shirt, name tag, map dot), not the roof.
 */
export function villageRoofColors(
	village: VillageLayout,
	palette: WorldPalette
): ReadonlyMap<string, string> {
	const roofs = new Map<string, string>();
	village.houses.forEach((house, index) => {
		roofs.set(
			house.agentId,
			palette.roofs[index % palette.roofs.length] ?? ROOF_PALETTE[0]
		);
	});
	return roofs;
}
