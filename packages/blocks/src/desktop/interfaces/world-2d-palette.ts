import type { WorldTheme } from "@ryuhq/protocol/interfaces";

/**
 * Pixel-art colors for the 2D village, in the warm, saturated Pelican Town
 * spirit: greens lean yellow in the light and blue in the shade, wood is
 * orange-brown, outlines are deep shades of their object, never black.
 * Night reuses the day art under a blue multiply with lights cut out.
 */
export interface PixelLeafTones {
	dark: string;
	glint: string;
	light: string;
	/** Outline around the canopy: a deep shade of the leaves. */
	line: string;
	mid: string;
}

export interface PixelScene {
	/** Fill beyond the drawn scene. */
	backdrop: string;
	cobble: {
		/** The square's curb stones: lit top, face, shaded foot. */
		curb: readonly [string, string, string];
		dark: string;
		gap: string;
		light: string;
		/** Moss on the odd old stone and grass in the cracks. */
		moss: string;
		/** Warm beige to cool blue-grey, so the paving has hue variety. */
		stones: readonly [string, string, string, string];
	};
	dirt: {
		dark: string;
		edge: string;
		fill: string;
		light: string;
		shade: string;
	};
	flowers: readonly [string, string][];
	grass: readonly [string, string, string, string];
	grassBlade: string;
	grassTip: string;
	indoor: boolean;
	/** Multiply color laid over the scene (night), or null for daylight. */
	night: string | null;
	shadow: string;
	tree: {
		fruit: string;
		maple: PixelLeafTones;
		oak: PixelLeafTones;
		pine: PixelLeafTones;
		trunk: string;
	};
	water: { deep: string; fill: string; light: string; rim: string };
	wood: { dark: string; fill: string; light: string };
}

const DAY: PixelScene = {
	backdrop: "#2f5a2a",
	cobble: {
		curb: ["#efdcb4", "#d2b98e", "#a3876a"],
		dark: "#5e4634",
		gap: "#6b5440",
		light: "#f4e8cc",
		moss: "#7f9d48",
		stones: ["#b7a58a", "#ad9a7e", "#a8977f", "#9c8a70"],
	},
	dirt: {
		dark: "#9a6b3f",
		edge: "#87592f",
		fill: "#d8aa6c",
		light: "#e8c48a",
		shade: "#c4935a",
	},
	flowers: [
		["#ffd93b", "#f08a24"],
		["#ff8fc0", "#c94b8c"],
		["#7aa8ff", "#3f5fc4"],
		["#ffffff", "#f2c94c"],
		["#ff6b5a", "#b8302c"],
	],
	grass: ["#5fa83a", "#6db541", "#79bf47", "#4f9534"],
	grassBlade: "#3f7f2e",
	grassTip: "#97d35a",
	indoor: false,
	night: null,
	shadow: "#24402a",
	tree: {
		fruit: "#e2443e",
		maple: {
			dark: "#3d7428",
			glint: "#c9e46c",
			light: "#8cc443",
			line: "#3a5a22",
			mid: "#5f9e30",
		},
		oak: {
			dark: "#2c6a37",
			glint: "#a6d85e",
			light: "#5fae45",
			line: "#1f4a2a",
			mid: "#3f8c3a",
		},
		pine: {
			dark: "#1d4c44",
			glint: "#7cc483",
			light: "#3f9466",
			line: "#14382f",
			mid: "#2a6b52",
		},
		trunk: "#8a5a33",
	},
	water: { deep: "#2f6fb0", fill: "#4c98d8", light: "#9ad8f2", rim: "#c49a62" },
	wood: { dark: "#6b3a1c", fill: "#b5702f", light: "#dd9a4e" },
};

const OFFICE: PixelScene = {
	...DAY,
	backdrop: "#1d1412",
	cobble: {
		curb: ["#fbf4e6", "#eadfca", "#bca78e"],
		dark: "#a48f78",
		gap: "#bca78e",
		light: "#fbf4e6",
		moss: "#8fae5a",
		stones: ["#eadfca", "#e2d4bb", "#f1e7d4", "#e6dccb"],
	},
	dirt: {
		dark: "#7a2a2a",
		edge: "#4a1a1c",
		fill: "#b8403a",
		light: "#d8644e",
		shade: "#9c3432",
	},
	grass: ["#c98d52", "#bf8249", "#d49a5c", "#b07540"],
	grassBlade: "#8f5a30",
	grassTip: "#e2ad6c",
	indoor: true,
	shadow: "#4a2a1a",
};

const NIGHT: PixelScene = {
	...DAY,
	backdrop: "#132a24",
	night: "#3c4a9a",
};

export const PIXEL_SCENES: Record<WorldTheme, PixelScene> = {
	meadow: DAY,
	night: NIGHT,
	office: OFFICE,
};

/**
 * Stardew's menu colors for the HUD and the talk panel (game chrome, not
 * the app's theme): brown ink on parchment, orange wood, the red selection
 * frame and the gold focus ring. Components read them as `--sv-*` CSS
 * variables (see {@link svCssVariables}) or, for pixel SVGs, directly.
 */
export const SV_UI = {
	/** The "!" quest marker's amber and its shade. */
	alert: "#f08a12",
	alertLine: "#a8520a",
	/** Close "X": bright and deep red. */
	close: "#e2453a",
	closeDark: "#7a1410",
	/** Gold focus ring around HUD controls. */
	focus: "#ffd25e",
	/** Villager names in the plank tooltip. */
	gold: "#ffe08a",
	/** Working: the green of a lit lamp-post leaf. */
	green: "#5fae45",
	greenDark: "#2c6a37",
	greenText: "#2f6b1f",
	/** Text on parchment, its secondary shade and its soft drop shadow. */
	ink: "#3d1f0d",
	inkShadow: "#e2b36e",
	inkSoft: "#7a4a24",
	/** Keycap face and bevel. */
	key: "#fbe1a6",
	keyShade: "#d9a25a",
	/** Night badge on the clock. */
	night: "#3a3f7a",
	nightInk: "#f6e7a6",
	/** Deepest outline. */
	outline: "#3f1c08",
	/** Parchment: page, field, and the hover fill of a dialogue choice. */
	parchment: "#fbe1a6",
	parchmentDeep: "#ecc681",
	parchmentField: "#fff3cf",
	parchmentFieldShade: "#e9c98d",
	/** Text on wood planks. */
	plankInk: "#fff4d6",
	/** Hotbar selection red and its dark edge. */
	red: "#e2453a",
	redDark: "#8a1a12",
	/** Slot well and its shade. */
	slot: "#f7d798",
	slotShade: "#c99a5a",
	/** The talk panel's backing planks. */
	wallDark: "#4e2711",
	wallFill: "#6b3a1c",
	wallGap: "#5b2f15",
	wallPlank: "#7a4421",
	/** Wood outline under plank text. */
	woodDark: "#5b2a0b",
} as const;

/** Pixel icon colors in the HUD (clock, season, map). */
export const SV_ICONS = {
	cloud: "#ffffff",
	dialDawn: "#9fd8f0",
	dialDusk: "#f2b36a",
	dialHand: "#d6302a",
	dialHorizon: "#d6782a",
	dialNightDawn: "#2c3170",
	dialNightDusk: "#3a3f7a",
	dialSparkle: "#ffe4b0",
	leaf: "#5fae45",
	leafVein: "#2c6a37",
	moon: "#e8b040",
	moonGlint: "#fff2b0",
	moonShade: "#a8701a",
	star: "#f6e7a6",
	sun: "#ffd23f",
	sunGlint: "#fff6c0",
	sunRay: "#f0a020",
} as const;

/** Colors drawn on the village map canvas. */
export const SV_MAP = {
	alert: "#f08a12",
	edge: "#3f1c08",
	idle: "#fbe1a6",
	indoorTree: "#3f8c3a",
	indoorTreeLight: "#5fae45",
	player: "#ffd25e",
	playerRim: "#3f1c08",
	roof: "#b5523b",
	working: "#7ee06b",
} as const;

const kebab = (name: string) =>
	name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);

/**
 * The HUD colors as `--sv-*` custom properties, set once on the world's
 * root so Tailwind classes can use `bg-(--sv-parchment)` and friends.
 */
export function svCssVariables(): Record<`--sv-${string}`, string> {
	const variables: Record<`--sv-${string}`, string> = {};
	for (const [name, value] of Object.entries(SV_UI)) {
		variables[`--sv-${kebab(name)}`] = value;
	}
	return variables;
}

/** Skin tones (fill and shade) villagers are drawn with. */
export const SKIN_TONES = [
	{ fill: "#f7d7b8", shade: "#e0b48f" },
	{ fill: "#eab48c", shade: "#cc9067" },
	{ fill: "#c48a5f", shade: "#a26a43" },
	{ fill: "#8d5b3c", shade: "#6c4129" },
] as const;

/** Hair colors villagers are drawn with. */
export const HAIR_COLORS = [
	"#2b1d16",
	"#6b3e21",
	"#e0ad48",
	"#c4512f",
	"#3c3b55",
] as const;

/** The "!" quest emote: bubble inks and the mark's tone per status. */
export const SV_QUEST = {
	attention: { fill: "#e0322a", shade: "#8a1a12" },
	bubbleFill: "#fffdf6",
	bubbleShade: "#d9d2e6",
	outline: "#3b2a3f",
	yourTurn: { fill: "#f08a12", shade: "#a8520a" },
} as const;

/**
 * The village's indexed art palette: every color the sprite painters
 * (cottages, villagers, flora, ground, light and water effects) use, named
 * by hue family and lightness step (5 lightest to 995 darkest; a second swatch at the same step is the more muted one), the way a
 * pixel artist works from a fixed swatch set. Scene-specific tones live in
 * `PIXEL_SCENES`; HUD colors in `SV_UI`.
 */
export const SWATCH = {
	amber115: "#f2e6d2",
	amber115Muted: "#e8e4dc",
	amber145: "#ffe2b4",
	amber145Muted: "#f1e3c4",
	amber155: "#ffe2b0",
	amber155Dusty: "#e8dcc8",
	amber155Muted: "#f7d7b8",
	amber215: "#d9cdb8",
	amber220: "#e9d2a6",
	amber225: "#e2d0a8",
	amber235: "#e6d0a0",
	amber235Muted: "#cfc7b8",
	amber255: "#e3cd9a",
	amber260: "#ffd77a",
	amber285: "#ecc681",
	amber285Dusty: "#c9bca4",
	amber285Muted: "#d9c294",
	amber290: "#ffcf6a",
	amber300: "#c4b6a2",
	amber305: "#d9c08a",
	amber305Muted: "#c8b49a",
	amber325: "#b8ada0",
	amber330: "#c9b48c",
	amber335: "#d9b27a",
	amber335Muted: "#d4b47e",
	amber340: "#cdb484",
	amber365: "#ffa846",
	amber365Muted: "#e9bd5a",
	amber370: "#c9a878",
	amber375: "#d9a066",
	amber380: "#ff9a3d",
	amber380Muted: "#c7a676",
	amber405: "#f0b040",
	amber410: "#f29a3a",
	amber410Ashen: "#d49a58",
	amber410Dusty: "#e2b04a",
	amber410Faded: "#d39a5a",
	amber410Muted: "#e2b34a",
	amber415: "#f0a83a",
	amber420: "#e0ad48",
	amber420Muted: "#a89880",
	amber425: "#c49a62",
	amber430: "#c99a5a",
	amber445: "#e2a03a",
	amber445Muted: "#c98f52",
	amber460: "#f08a24",
	amber460Muted: "#c98a4a",
	amber470: "#c48a4a",
	amber495: "#c8963a",
	amber495Muted: "#b8864a",
	amber525: "#b8863a",
	amber535: "#a87a46",
	amber550: "#a8743e",
	amber555: "#b5702f",
	amber555Muted: "#a8713a",
	amber585: "#9a6a3a",
	amber590: "#a8742a",
	amber645: "#7a5a3a",
	amber680: "#7a5a2a",
	amber90: "#fff0d0",
	black990: "#000000",
	blue130: "#d8dce4",
	blue260: "#7aa8ff",
	blue325: "#7f9bd8",
	blue420: "#4f8fd8",
	blue455: "#5a8cbc",
	blue455Muted: "#5f7fb8",
	blue530: "#4f6fa0",
	blue535: "#4561a8",
	blue550: "#3e5fa8",
	blue575: "#4b5b8f",
	blue605: "#4a5a80",
	blue635: "#3f5a7a",
	blue680: "#2c3f78",
	blue690: "#3f4a5f",
	blue755: "#2c3550",
	blue775: "#2a3a4a",
	blue830: "#18213f",
	blue95: "#cfd6ff",
	coolGrey185: "#c9ccd6",
	coolGrey195: "#c9c9d2",
	coolGrey280: "#b4b4bc",
	coolGrey370: "#9a9aa8",
	coolGrey390: "#8f98a8",
	coolGrey495: "#6f8a92",
	coolGrey525: "#7a6a88",
	coolGrey545: "#6e6880",
	coolGrey550: "#6a6680",
	coolGrey555: "#6a6a78",
	coolGrey650: "#5a5260",
	coolGrey660: "#4f4e5f",
	coolGrey695: "#4a4458",
	coolGrey735: "#3b3f4c",
	coolGrey740: "#3d3a4a",
	coolGrey800: "#2c2f3a",
	cyan150: "#cfe0e2",
	cyan300: "#a3bcc2",
	cyan50: "#e6fbff",
	cyan595: "#3f8f8c",
	fuchsia575: "#8a4f7a",
	fuchsia700: "#5a3f5a",
	green185: "#c8f0b0",
	green380: "#8cc27a",
	green440: "#7cc45a",
	green445: "#79c25a",
	green485: "#8cc443",
	green505: "#7f9a62",
	green525: "#6fae45",
	green525Muted: "#4aa86a",
	green545: "#4f9a6a",
	green555: "#5aa83a",
	green555Dusty: "#4f9f45",
	green555Muted: "#5fa83a",
	green585: "#4f9a3a",
	green585Muted: "#4a8a52",
	green595: "#3f8f4a",
	green605: "#4f9534",
	green640: "#3f8a2e",
	green670: "#2f7a3a",
	green675: "#3c7a2c",
	green730: "#2c5e3a",
	green855: "#17331f",
	green880A13: "#1d2a1422",
	green880A33: "#1d2a1455",
	grey185: "#d0d0d0",
	grey40: "#f2f3f7",
	grey50: "#f2f2f2",
	grey710: "#4a4a4a",
	grey90: "#e6e6ea",
	indigo255: "#b8b4c8",
	indigo720: "#3c3b55",
	lime200: "#f4ff9a",
	lime335: "#c8e86a",
	lime480: "#9aa860",
	orange280: "#e0b48f",
	orange305: "#d9a58a",
	orange470: "#c46a4a",
	orange490: "#c8643c",
	orange520: "#b8763e",
	orange525: "#c4512f",
	orange530: "#b4553c",
	orange540: "#b0583a",
	orange555: "#a8683a",
	orange580: "#a8642e",
	orange590: "#9c5f34",
	orange595: "#9a5f34",
	orange600: "#93633a",
	orange605: "#a0432a",
	orange610: "#9a5a2c",
	orange625: "#8f5530",
	orange630: "#8a5a33",
	orange645: "#8a4f2a",
	orange665: "#7a5232",
	orange675: "#6b4a3a",
	orange680: "#7a4a2a",
	orange690: "#7a4a24",
	orange710: "#5d4636",
	orange715: "#6b4226",
	orange725: "#6b3e21",
	orange735: "#6b3a1c",
	orange755: "#5a3a22",
	orange780: "#5b2f15",
	orange785: "#4a3024",
	orange815: "#4e2711",
	orange825: "#4a2410",
	orange875: "#2b1d16",
	orange900: "#2e1406",
	pink115: "#ffc4d6",
	pink195: "#ff9cc4",
	pink20: "#fff4f8",
	pink335: "#e86a9a",
	pink355: "#e8608a",
	purple440: "#9a5ac4",
	purple720: "#4a3a55",
	purple795: "#3b2a3f",
	purple855: "#2b1b2e",
	red250: "#ff8a80",
	red430: "#d8504a",
	red435: "#e2443e",
	red460: "#d8463c",
	red480: "#d0503a",
	red490: "#c8463c",
	red525: "#c2402f",
	red530: "#b5523b",
	red535: "#b0413e",
	red585: "#9a3f3a",
	red595: "#a2302c",
	red805: "#3a2a2a",
	rose290: "#ff6b8b",
	rose400: "#c46f86",
	rose820: "#3a2226",
	sky125: "#bfe6ff",
	sky135: "#c4e4f4",
	sky150: "#b9e4f8",
	sky210: "#9fd6f5",
	sky225: "#9ad8f2",
	sky325: "#5ad0ff",
	sky325Muted: "#7fb3d8",
	sky390: "#5fa8d8",
	sky400: "#4ab8e8",
	sky425: "#4c98d8",
	sky45: "#e8f8ff",
	sky490: "#3f86c4",
	sky595: "#3f6a8f",
	sky75: "#d8f2ff",
	violet135: "#d9d2e6",
	violet25: "#f8f6fc",
	violet260: "#9a7bff",
	violet400: "#8f7ab8",
	violet465: "#7a6aa8",
	violet580: "#6a5a7d",
	violet660: "#4e4866",
	violet80: "#e8e4f0",
	warmGrey310: "#b9b4a8",
	warmGrey315: "#b8b2a6",
	warmGrey320: "#b8aea2",
	warmGrey375: "#a8a096",
	warmGrey395: "#a49a90",
	warmGrey395Muted: "#a39a92",
	warmGrey405: "#a29a8e",
	warmGrey415: "#a0928a",
	warmGrey440: "#9a8f84",
	warmGrey520: "#8a7a6a",
	warmGrey565: "#7a6a64",
	warmGrey585: "#6f6a64",
	warmGrey865: "#2a1e1a",
	white10: "#fbfbfd",
	white10Muted: "#ffffff",
	yellow100: "#fff6cc",
	yellow110: "#fff2c8",
	yellow140: "#fff2b8",
	yellow155: "#fff2b0",
	yellow160: "#e8e2c4",
	yellow165: "#f2e2b8",
	yellow170: "#f3e1b5",
	yellow185: "#fff3a0",
	yellow190: "#f6e2a8",
	yellow190Dusty: "#efdcae",
	yellow190Muted: "#f4e4a8",
	yellow195: "#fbe3a0",
	yellow20: "#fffdf6",
	yellow225: "#e2d2aa",
	yellow260: "#ffe07a",
	yellow285: "#f2d27a",
	yellow285Muted: "#c9c2a4",
	yellow290: "#f0d27a",
	yellow30: "#fbfaf4",
	yellow315: "#ffd45e",
	yellow375: "#f2c94c",
	yellow385: "#ffd93b",
	yellow480: "#c9a23f",
	yellow70: "#fff6dc",
	yellow70Muted: "#f6f1e4",
	yellow75: "#fbf4dc",
	yellow80: "#fff4d6",
	yellow90: "#fff8d0",
	yellow95: "#fff1cf",
} as const;

/**
 * The 9-slice frame pixel keys (see `world-2d-frame.ts`): o outer outline,
 * L wood highlight, W wood, D wood shade, k inner dark line, q parchment
 * shadow, p parchment, s slot fill, S slot shade, R/r selection red and its
 * dark edge.
 */
export const SV_FRAME = {
	D: "#9c4f17",
	k: "#5b2a0b",
	L: "#f0a24a",
	o: "#3f1c08",
	p: "#fbe1a6",
	q: "#ecc681",
	R: "#e2453a",
	r: "#8a1a12",
	S: "#c99a5a",
	s: "#f7d798",
	W: "#d6782a",
} as const;

/** Stardew text inks: brown on parchment, cream on wood planks. */
export const SV_TEXT_INK = {
	ink: "#3d1f0d",
	inkShadow: "#e2b36e",
	plank: "#fff4d6",
	plankEdge: "#5b2a0b",
	plankShadow: "rgba(63, 28, 8, 0.45)",
} as const;

/**
 * The act layer's sprite inks: the hourglass plaque over an asking
 * villager, the progress pips over a working one's roof, the zzz and clock
 * of a limit, the chest of answers on your doorstep, the letter or scroll
 * an asker carries, alarm lamps, helpers, the next step's sign and tools.
 */
export const WORLD_2D_ACT = {
	chest: "#a8642c",
	/** An interrupted run's flag and pole. */
	flag: "#9aa0a8",
	flagPole: "#5b5e66",
	/** A suggestion's note. */
	note: "#fff3a8",
	/** A notice post's board and post. */
	post: "#8a5a2b",
	chestBand: "#5b2a0b",
	chestLock: "#f2c14e",
	clockFace: "#fff4dc",
	clockRim: "#e0a030",
	glass: "#9fd6f0",
	ink: "#3d1f0d",
	letter: "#fffdf6",
	letterSeal: "#e0322a",
	outline: "#3f1c08",
	pipDone: "#ffd84d",
	pipTodo: "#5b6470",
	plaque: "#fffdf6",
	sand: "#f2c14e",
	scroll: "#f2e6d2",
	zzz: "#cfe3ff",
	/** A counted failure's alarm lamp, and an old one's dim lamp. */
	alarm: "#e0322a",
	alarmBase: "#5b5e66",
	alarmDim: "#8b8f96",
	alarmGlint: "#ffd1c9",
	/** A running helper following its agent. */
	follower: "#6fb3e0",
	followerSkin: "#f2c79b",
	/** The next step's signpost board and its arrow. */
	signArrow: "#fffdf6",
	/** The tool a working villager holds. */
	toolMetal: "#aab4be",
	toolWood: "#a8642c",
	toolGlobe: "#4fa3d9",
	/** The wait plaque by how long the ask has waited (waitBand). */
	waitFresh: "#fffdf6",
	waitWaiting: "#fff3c4",
	waitLong: "#ffd9a0",
	waitStale: "#f2c4bc",
	waitExpiring: "#ff9f8f",
	waitUnknown: "#e8e4dc",
} as const;
