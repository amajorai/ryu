/**
 * Arcade art: carpet, walls, cabinet skins, reel glyphs, bulbs, coins and
 * tickets. This is the one Arcade file where literal colours live; the HUD
 * and the side panel take the theme's semantic tokens instead. The walls
 * are mixed with the theme background so the floor sits inside the user's
 * theme. Two moods: a bright daytime casino for light themes and a neon
 * night floor for dark ones.
 */

export type ArcadeMode = "dark" | "light";

export interface CabinetSkin {
	/** Main cabinet face. */
	body: string;
	/** Bulb colour when lit. */
	bulb: string;
	/** Side and lower panels, a step darker than the face. */
	shade: string;
	/** Marquee panel fill. */
	sign: string;
	/** Marquee lettering. */
	signText: string;
	/** Chrome or gold trim around the reel window and marquee. */
	trim: string;
}

export interface ArcadePalette {
	/** Unlit chase bulb. */
	bulbOff: string;
	carpetBase: string;
	carpetDot: string;
	carpetMotif: string;
	carpetStar: string;
	coin: string;
	coinEdge: string;
	/** Light spilling from the back wall onto the carpet, fading to the room. */
	floorLight: string;
	/** Inner shadow under a cabinet where it meets the carpet. */
	floorShadow: string;
	/** An unlit cabinet (power off): loading silhouettes and the empty floor. */
	ghost: Record<"body" | "screen" | "shade" | "sign", string>;
	/** Glass of the prize case on the back wall. */
	glass: string;
	/** Text on the arcade cabinet screens. */
	glyph: Record<
		"bar" | "barText" | "bell" | "bellEdge" | "blank" | "cherry" | "flame",
		string
	> & {
		flameCore: string;
		leaf: string;
		seven: string;
		sevenEdge: string;
	};
	ledBackground: string;
	/** Unlit LED digits: a ghost of the segments, not text to read. */
	ledDim: string;
	/** A lit green status LED (the change machine's bill slot). */
	ledGo: string;
	/** Small legends on the LED panels (CREDIT, WIN): at least 4.5:1. */
	ledLabel: string;
	ledLit: string;
	ledTilt: string;
	lever: string;
	leverKnob: string;
	/** Brushed metal of the change machine and the lever's mounting plate. */
	metal: string;
	metalShade: string;
	mode: ArcadeMode;
	/** Neon tube along the back wall (night) or brass rail (day). */
	neon: string;
	payline: string;
	/** Smoked cover over a reel that has no conversation on it. */
	reelCover: string;
	reelFace: string;
	/** Drum shading over the reel face: darker at the top and bottom edges. */
	reelShade: string;
	screen: string;
	screenDim: string;
	screenText: string;
	/** The lit edge marking the reel and ticket whose conversation is open. */
	selected: string;
	/** The pool of light the empty floor's unlit machine stands in. */
	spotlight: string;
	ticket: string;
	ticketInk: string;
	/** Barcode stripes on a ticket. */
	ticketStripes: string;
	tray: string;
	trayText: string;
	wall: string;
	wallBase: string;
	wallLight: string;
	wallPanel: string;
	/** The warm pool a wall light throws behind each upright. */
	wallPool: string;
	/** Panel seams along the back wall. */
	wallSeams: string;
	/** Painted or neon lettering on the back wall. */
	wallSign: string;
	/** Outline and drop of painted wall lettering (day); unused at night. */
	wallSignEdge: string;
}

const LIGHT: ArcadePalette = {
	bulbOff: "#b89d73",
	carpetBase: "color-mix(in oklab, var(--primary) 12%, #ead2ad)",
	carpetDot: "#b4772a",
	carpetMotif: "rgb(150 64 32 / 0.16)",
	carpetStar: "rgb(28 112 110 / 0.7)",
	coin: "#f1c04f",
	coinEdge: "#b4842a",
	floorLight:
		"linear-gradient(180deg, rgb(70 36 12 / 0.22) 0, rgb(70 36 12 / 0) 40px, rgb(255 250 235 / 0.16) 35%, rgb(70 36 12 / 0.06) 100%)",
	floorShadow: "rgb(60 28 10 / 0.32)",
	glyph: {
		bar: "#24232a",
		barText: "#fdfbf6",
		bell: "#f0b429",
		bellEdge: "#9a6608",
		blank: "#9c9180",
		cherry: "#d3263d",
		flame: "#f2621f",
		flameCore: "#ffd23f",
		leaf: "#3d8a3a",
		seven: "#d3263d",
		sevenEdge: "#7d0f1f",
	},
	ghost: {
		body: "#5f5048",
		screen: "#1d1a22",
		shade: "#4a3e37",
		sign: "#2e2622",
	},
	glass: "rgb(232 244 248 / 0.55)",
	ledBackground: "#1c1411",
	ledDim: "#4a3720",
	ledLabel: "#a8885c",
	ledLit: "#ffb43a",
	ledGo: "#3ddc84",
	ledTilt: "#ff4d4d",
	lever: "#c7cad1",
	leverKnob: "#d3263d",
	metal: "#9aa0aa",
	metalShade: "#6d727c",
	mode: "light",
	neon: "color-mix(in oklab, var(--primary) 70%, #b98a45)",
	payline: "rgb(211 38 61 / 0.55)",
	reelCover:
		"linear-gradient(180deg, rgb(40 26 20 / 0.62), rgb(40 26 20 / 0.48) 50%, rgb(40 26 20 / 0.62))",
	reelFace: "#fbf7ef",
	reelShade:
		"linear-gradient(180deg, rgb(40 24 16 / 0.42) 0%, rgb(40 24 16 / 0.06) 20%, rgb(40 24 16 / 0) 32%, rgb(40 24 16 / 0) 68%, rgb(40 24 16 / 0.06) 80%, rgb(40 24 16 / 0.42) 100%)",
	screen: "#14182b",
	screenDim: "#7d86b8",
	screenText: "#f4f6ff",
	selected: "#e8590c",
	ticket: "#f6ecc8",
	ticketInk: "#3a2f1a",
	ticketStripes:
		"repeating-linear-gradient(90deg, #3a2f1a 0 1px, transparent 1px 3px, #3a2f1a 3px 5px, transparent 5px 6px)",
	tray: "#2a1d1a",
	trayText: "#a8907c",
	wall: "color-mix(in oklab, color-mix(in oklab, var(--background) 30%, #e9cfa3) 94%, var(--primary))",
	wallBase: "#7a4a2b",
	wallLight:
		"radial-gradient(60% 120% at 50% 0%, rgb(255 236 196 / 0.75), rgb(255 236 196 / 0) 70%)",
	wallPanel: "color-mix(in oklab, var(--background) 35%, #e6cfa8)",
	wallPool:
		"radial-gradient(50% 50% at 50% 30%, rgb(255 236 200 / 0.85), rgb(255 236 200 / 0) 100%)",
	wallSeams:
		"repeating-linear-gradient(90deg, rgb(122 74 43 / 0) 0 159px, rgb(122 74 43 / 0.14) 159px 160px)",
	wallSign: "color-mix(in oklab, var(--primary) 14%, #a3261c)",
	wallSignEdge: "#5c1610",
	spotlight:
		"radial-gradient(closest-side, rgb(255 247 230 / 0.94), rgb(255 247 230 / 0.78) 55%, rgb(255 247 230 / 0))",
};

const DARK: ArcadePalette = {
	bulbOff: "#4a3a2a",
	carpetBase: "color-mix(in oklab, var(--primary) 12%, #181229)",
	carpetDot: "#8a6a2c",
	carpetMotif: "rgb(150 120 255 / 0.1)",
	carpetStar: "rgb(40 140 155 / 0.65)",
	coin: "#f4c64f",
	coinEdge: "#a77a22",
	floorLight:
		"linear-gradient(180deg, rgb(0 0 0 / 0.5) 0, rgb(0 0 0 / 0) 48px, rgb(255 79 163 / 0.04) 30%, rgb(0 0 0 / 0.3) 100%)",
	floorShadow: "rgb(0 0 0 / 0.5)",
	glyph: {
		bar: "#1b1a20",
		barText: "#fdfbf6",
		bell: "#f5bd32",
		bellEdge: "#8f5c06",
		blank: "#958d7f",
		cherry: "#e0304a",
		flame: "#f2621f",
		flameCore: "#ffd23f",
		leaf: "#3f9442",
		seven: "#e0304a",
		sevenEdge: "#6f0b1a",
	},
	ghost: {
		body: "#2a2440",
		screen: "#0b0914",
		shade: "#1f1a31",
		sign: "#141022",
	},
	glass: "rgb(120 200 255 / 0.12)",
	ledBackground: "#0d0a0a",
	ledDim: "#3a2a14",
	ledLabel: "#9c7c50",
	ledLit: "#ffb43a",
	ledGo: "#3ddc84",
	ledTilt: "#ff5a5a",
	lever: "#a9adb6",
	leverKnob: "#e0304a",
	metal: "#3b3f4b",
	metalShade: "#272a33",
	mode: "dark",
	neon: "color-mix(in oklab, var(--primary) 82%, #ffffff)",
	payline: "rgb(255 79 163 / 0.6)",
	reelCover:
		"linear-gradient(180deg, rgb(8 6 16 / 0.78), rgb(8 6 16 / 0.62) 50%, rgb(8 6 16 / 0.78))",
	reelFace: "#f4efe4",
	reelShade:
		"linear-gradient(180deg, rgb(10 6 20 / 0.6) 0%, rgb(10 6 20 / 0.1) 20%, rgb(10 6 20 / 0) 32%, rgb(10 6 20 / 0) 68%, rgb(10 6 20 / 0.1) 80%, rgb(10 6 20 / 0.6) 100%)",
	screen: "#0a0d1c",
	screenDim: "#6670a8",
	screenText: "#e9ecff",
	selected: "#ffb43a",
	ticket: "#efe3bb",
	ticketInk: "#33291a",
	ticketStripes:
		"repeating-linear-gradient(90deg, #33291a 0 1px, transparent 1px 3px, #33291a 3px 5px, transparent 5px 6px)",
	tray: "#0f0b12",
	trayText: "#8a7a98",
	wall: "color-mix(in oklab, color-mix(in oklab, var(--background) 40%, #151129) 90%, var(--primary))",
	wallBase: "#0c0a18",
	wallLight:
		"radial-gradient(60% 120% at 50% 0%, rgb(120 70 220 / 0.22), rgb(120 70 220 / 0) 70%)",
	wallPanel: "color-mix(in oklab, var(--background) 30%, #1d1836)",
	wallPool:
		"radial-gradient(50% 50% at 50% 30%, color-mix(in oklab, var(--primary) 30%, transparent), transparent 100%)",
	wallSeams:
		"repeating-linear-gradient(90deg, rgb(255 255 255 / 0) 0 159px, rgb(255 255 255 / 0.05) 159px 160px)",
	wallSign: "color-mix(in oklab, var(--primary) 75%, #ffffff)",
	wallSignEdge: "#0c0a18",
	spotlight:
		"radial-gradient(closest-side, rgb(16 12 30 / 0.94), rgb(16 12 30 / 0.78) 55%, rgb(16 12 30 / 0))",
};

export function arcadePalette(mode: ArcadeMode): ArcadePalette {
	return mode === "dark" ? DARK : LIGHT;
}

/** Six cabinet finishes, picked per agent id so a machine keeps its look. */
const SKINS_LIGHT: readonly CabinetSkin[] = [
	{
		body: "#c8323f",
		bulb: "#fff1c2",
		shade: "#8e1f2b",
		sign: "#2a1418",
		signText: "#ffe39a",
		trim: "#e8c46a",
	},
	{
		body: "#2f62c4",
		bulb: "#fff1c2",
		shade: "#1f4189",
		sign: "#111a33",
		signText: "#bfe0ff",
		trim: "#d9dde6",
	},
	{
		body: "#24865f",
		bulb: "#fff1c2",
		shade: "#165a3f",
		sign: "#0d2219",
		signText: "#c8f5c0",
		trim: "#e8c46a",
	},
	{
		body: "#7a3fb8",
		bulb: "#fff1c2",
		shade: "#522882",
		sign: "#1d1030",
		signText: "#f1d2ff",
		trim: "#d9dde6",
	},
	{
		body: "#e07a24",
		bulb: "#fff1c2",
		shade: "#a65314",
		sign: "#2b170a",
		signText: "#ffe3a8",
		trim: "#f2e1b3",
	},
	{
		body: "#2a2a33",
		bulb: "#fff1c2",
		shade: "#16161c",
		sign: "#0e0e12",
		signText: "#f5cd5c",
		trim: "#e8c46a",
	},
];

const SKINS_DARK: readonly CabinetSkin[] = [
	{
		body: "#a3243a",
		bulb: "#ffd6f0",
		shade: "#62121f",
		sign: "#14080c",
		signText: "#ff8fc8",
		trim: "#ff4fa3",
	},
	{
		body: "#2148a3",
		bulb: "#cff6ff",
		shade: "#132a63",
		sign: "#060c1d",
		signText: "#6fe6ff",
		trim: "#34e1f0",
	},
	{
		body: "#1a6e4e",
		bulb: "#d7ffe4",
		shade: "#0e4130",
		sign: "#04140d",
		signText: "#7dffb2",
		trim: "#4cf59a",
	},
	{
		body: "#5e2c95",
		bulb: "#f1dbff",
		shade: "#371959",
		sign: "#0d0618",
		signText: "#d49bff",
		trim: "#b46bff",
	},
	{
		body: "#b85a17",
		bulb: "#ffe7c4",
		shade: "#6e330a",
		sign: "#170b03",
		signText: "#ffb84d",
		trim: "#ffa53a",
	},
	{
		body: "#24232e",
		bulb: "#fff2c2",
		shade: "#111017",
		sign: "#07070a",
		signText: "#ffd35c",
		trim: "#ffd35c",
	},
];

export function cabinetSkin(mode: ArcadeMode, index: number): CabinetSkin {
	const skins = mode === "dark" ? SKINS_DARK : SKINS_LIGHT;
	const fallback = skins[0] as CabinetSkin;
	return skins[index % skins.length] ?? fallback;
}

export const SKIN_COUNT = SKINS_LIGHT.length;

/**
 * The carpet tile as an SVG data URI: a lattice of diamonds with gold dots
 * and small four-point stars, the classic casino floor repeat. The tile is
 * transparent between its marks so the carpet's base colour (mixed with the
 * theme's primary, which a data URI cannot read) shows through.
 */
export function carpetTile(palette: ArcadePalette): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path d="M32 4 60 32 32 60 4 32Z" fill="none" stroke="${palette.carpetMotif}" stroke-width="6"/><path d="M32 18 46 32 32 46 18 32Z" fill="${palette.carpetMotif}"/><path d="M32 26 34 30 38 32 34 34 32 38 30 34 26 32 30 30Z" fill="${palette.carpetStar}"/><circle cx="0" cy="0" r="3" fill="${palette.carpetDot}"/><circle cx="64" cy="0" r="3" fill="${palette.carpetDot}"/><circle cx="0" cy="64" r="3" fill="${palette.carpetDot}"/><circle cx="64" cy="64" r="3" fill="${palette.carpetDot}"/><circle cx="32" cy="32" r="1.6" fill="${palette.carpetDot}"/></svg>`;
	return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** Soft glow behind a lit bulb (night only: daytime bulbs read without it). */
export function bulbGlow(mode: ArcadeMode, color: string): string | undefined {
	return mode === "dark" ? `0 0 6px 1px ${color}` : undefined;
}

/** Perforated edge for the redemption-counter ticket header (a mask, not a colour). */
export const PERFORATION_MASK =
	"radial-gradient(circle at 6px 100%, transparent 3.5px, #000 4px) -6px 0 / 12px 100% repeat-x";

/**
 * The 3D arcade hall's colours (carpet, walls, neon, the reels' symbols),
 * on top of the game kit's shared scene palette (`game3d-palette.ts`).
 * Cabinets wear their `CabinetSkin`.
 */
export const ARCADE_3D = {
	carpet: ["#8a3456", "#7a2c4b"],
	carpetNight: ["#3f2350", "#351d45"],
	carpetStar: "#f2c14e",
	claw: "#5aa9e6",
	counter: "#c8873f",
	counterTop: "#f6e3c6",
	glass: "#d6f3ff",
	knob: "#e8384a",
	lever: "#c9cdd6",
	neon: ["#ff5fae", "#4fe3ff", "#ffd84d"],
	prizes: ["#ff8fb8", "#8fd4ff", "#ffd36e", "#b49bff", "#8fe0a6"],
	reel: "#fff8ea",
	screen: "#1d1a2e",
	screenIdle: "#5b6fd6",
	stool: "#d9304a",
	stoolLeg: "#a9b4c0",
	symbol: {
		bar: "#2a2a33",
		bell: "#f2b632",
		blank: "#c9c3cf",
		cherry: "#d9304a",
		flame: "#ff7a2e",
		seven: "#e8384a",
	},
	/** The finer parts of the reel glyphs: cherry stems, the bar's plate, a flame's core. */
	symbolDetail: {
		barText: "#fff8ea",
		bellKnob: "#c98a12",
		flameCore: "#ffd84d",
		leaf: "#3fa34d",
		stem: "#5b7a2e",
	},
	/** The act layer's marquee and screen lettering (TILT, INSERT COIN, the step). */
	marqueeInk: "#fff8ea",
	marqueeLimit: "#ffb648",
	/** An interrupted run: paused, not broken. */
	marqueePaused: "#cfc8bd",
	/** The act layer's credit bar (progress pips) and LED shot timer. */
	creditLit: "#ffb43a",
	creditDim: "#4a3720",
	creditEstimate: "#a8885c",
	ledTimer: "#ff7a2a",
	marqueeTilt: "#ff4a3a",
	/** A prize-ticket strip: the answer a player left on the counter. */
	ticket: "#ffb3c8",
	ticketEdge: "#e8384a",
	tilt: "#ff4a3a",
	topper: "#ffd84d",
	topperOff: "#8a7a5a",
	wall: "#f6e3c6",
	wallBase: "#9a4a3c",
	wallNight: "#3a3157",
	wallBaseNight: "#24203a",
} as const;
