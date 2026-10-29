/**
 * Market art: shop walls, awnings, doors, goods, cobbles and bunting for
 * the market-square diorama, plus the paper and cork of the order board in
 * the shop's sheet. This is the one Market file where literal colours live;
 * the HUD and the sheet's chrome take the theme's semantic tokens instead.
 *
 * The diorama sits on the game kit's shared scene palette
 * (`game3d-palette.ts`): `MARKET_3D` is the day street, `MARKET_3D_NIGHT`
 * the same street under the stars, its paint dimmed and its windows warm.
 */

/** How many wall, awning, door and goods variants the art has. */
export const MARKET_SWATCHES = {
	awning: 6,
	door: 5,
	goods: 5,
	wall: 6,
} as const;

export interface MarketArt {
	awning: readonly string[];
	awningLight: string;
	/** Bulbs strung along the bunting (lit at night). */
	bulb: string;
	bunting: readonly string[];
	cobble: readonly string[];
	cord: string;
	door: readonly string[];
	glass: string;
	goods: readonly string[];
	knob: string;
	litGlass: string;
	pavement: string;
	pole: string;
	roof: readonly string[];
	/** Each roof's darker shingle course and ridge, by the same index. */
	roofDark: readonly string[];
	sign: string;
	signEdge: string;
	/** The painted letters on a shop's signboard. */
	signInk: string;
	/** The fountain's stone and its water. */
	stone: string;
	stoneDark: string;
	street: string;
	table: string;
	trim: string;
	wall: readonly string[];
	water: string;
	wood: string;
	woodDark: string;
}

export const MARKET_3D: MarketArt = {
	awning: ["#e0675a", "#5f9d70", "#5a88c0", "#dfa63f", "#9d669f", "#3f9a90"],
	awningLight: "#fff8ec",
	bulb: "#ffe7a6",
	bunting: ["#f07a6a", "#f6c453", "#6cc0a8", "#7aa3e0", "#c48fd6"],
	cobble: ["#d9cdbd", "#cfc2b0", "#e3d8c9"],
	cord: "#8a6a52",
	door: ["#3f6f8f", "#a4573f", "#4f7c50", "#6d5796", "#b4813a"],
	glass: "#bfe0ee",
	goods: ["#ef7f63", "#f4c656", "#86c27a", "#7fa9df", "#cf92d2"],
	knob: "#f0c96a",
	litGlass: "#ffd98a",
	pavement: "#efe3cf",
	pole: "#fff4e4",
	roof: ["#d0664e", "#6f8fc0", "#9a74b0", "#c98f45", "#4f9a8a", "#d07a90"],
	roofDark: ["#a84e3c", "#56729e", "#7b5a90", "#a47234", "#3c7a6c", "#ac5f74"],
	sign: "#fff3dc",
	signEdge: "#8a5a3c",
	signInk: "#4a2c1a",
	stone: "#e6ddd0",
	stoneDark: "#c9bdad",
	water: "#7fd0ea",
	street: "#c2b4a2",
	table: "#c99566",
	trim: "#fffaf2",
	wall: ["#f6d2a8", "#c9e4b4", "#f5bfb4", "#bcd8f0", "#f7dc86", "#dccaf0"],
	wood: "#b07a4f",
	woodDark: "#7e5338",
};

export const MARKET_3D_NIGHT: MarketArt = {
	awning: ["#b5524a", "#4a7c59", "#4a6c9c", "#b58534", "#7c5281", "#357a73"],
	awningLight: "#d6ccbe",
	bulb: "#ffd27a",
	bunting: ["#b85e54", "#c39a46", "#4f907f", "#5a78a8", "#9068a2"],
	cobble: ["#8d8794", "#837d8b", "#97919d"],
	cord: "#5a4638",
	door: ["#2f5069", "#7a4232", "#3a5a3b", "#4f3f6d", "#82602d"],
	glass: "#3a4a6a",
	goods: ["#c46a56", "#d0a54a", "#6a9666", "#6585b0", "#a275a5"],
	knob: "#d9b25a",
	litGlass: "#ffc96b",
	pavement: "#a49ca6",
	pole: "#cfc6ba",
	roof: ["#8f4c40", "#4f6282", "#62507a", "#86663c", "#43695f", "#8c5766"],
	roofDark: ["#723c33", "#3e4e69", "#4e4062", "#6b5130", "#35544c", "#704552"],
	sign: "#efe2c8",
	signEdge: "#5f3f2c",
	signInk: "#3f2a1d",
	stone: "#9f978f",
	stoneDark: "#857d76",
	water: "#3f6fa8",
	street: "#76707e",
	table: "#8a6448",
	trim: "#d8cdbd",
	wall: ["#b89a80", "#90a882", "#b48a84", "#8aa0b8", "#b8a066", "#a294b8"],
	wood: "#7a573c",
	woodDark: "#553a29",
};

/** The awnings setting's presets (`mixed` is the art's own stock). */
export type MarketAwnings = "harvest" | "mixed" | "seaside";

/** The preset awning colours, by day and by night (six, like the stock). */
const MARKET_AWNINGS: Record<
	Exclude<MarketAwnings, "mixed">,
	{ day: readonly string[]; night: readonly string[] }
> = {
	harvest: {
		day: ["#d9733a", "#c4552f", "#e0a03a", "#a8642e", "#cf8a3c", "#b8452f"],
		night: ["#a9592d", "#984226", "#ae7c2e", "#834e25", "#a16b2f", "#8f3626"],
	},
	seaside: {
		day: ["#3f7fc0", "#2f9aa8", "#5aa6d8", "#2a6a9a", "#4fb0b8", "#6a8fd0"],
		night: ["#315f92", "#25767f", "#457fa5", "#215275", "#3d878c", "#526d9f"],
	},
};

/** The street's art by day or night, its awnings from the setting's preset. */
export function marketArt(
	night: boolean,
	awnings: MarketAwnings = "mixed"
): MarketArt {
	const art = night ? MARKET_3D_NIGHT : MARKET_3D;
	if (awnings === "mixed") {
		return art;
	}
	const preset = MARKET_AWNINGS[awnings];
	return { ...art, awning: night ? preset.night : preset.day };
}

/** A palette entry by index, wrapping. */
export function swatch(list: readonly string[], index: number): string {
	return list[index % list.length] ?? list[0] ?? MARKET_3D.trim;
}

/**
 * The order board's paper and cork as custom properties scoped to the
 * Market, so the slips follow light and dark themes without JavaScript.
 */
const SCOPE = "[data-market-scene]";

export const MARKET_SCENE_CSS = `
${SCOPE} {
--mk-cork: color-mix(in oklab, #d6a86c 88%, var(--primary));
--mk-paper: #fff9ee;
--mk-shade: #3a2a1f;
}
.dark ${SCOPE}, ${SCOPE}.dark {
--mk-cork: color-mix(in oklab, #55473a 86%, var(--background));
--mk-paper: #f4ead7;
--mk-shade: #0c0910;
}
`;

/** A palette color by name, as a CSS value. */
export function mk(name: string): string {
	return `var(--mk-${name})`;
}

/** A palette color at `percent` strength over transparent. */
function faded(name: string, percent: number): string {
	return `color-mix(in oklab, ${mk(name)} ${percent}%, transparent)`;
}

/**
 * Fractal noise as a tile: `alpha` of its red channel becomes the alpha of
 * `ink`, so the grain darkens (or lightens) whatever cork colour it lies on.
 */
function noiseTile(frequency: number, alpha: number, ink: number): string {
	const svg = [
		"<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>",
		"<filter id='g'>",
		`<feTurbulence type='fractalNoise' baseFrequency='${frequency}' numOctaves='2' stitchTiles='stitch'/>`,
		`<feColorMatrix values='0 0 0 0 ${ink} 0 0 0 0 ${ink} 0 0 0 0 ${ink} ${alpha} 0 0 0 0'/>`,
		"</filter>",
		"<rect width='100%' height='100%' filter='url(%23g)'/>",
		"</svg>",
	].join("");
	return `url("data:image/svg+xml,${svg}")`;
}

/**
 * The order board's cork: a fine grain and a coarser granule over the cork
 * colour, so it reads as pressed cork rather than a dotted grid.
 */
export const CORK_BOARD_STYLE = {
	backgroundColor: mk("cork"),
	backgroundImage: [noiseTile(0.85, 0.18, 0), noiseTile(0.22, 0.1, 0)].join(
		", "
	),
	boxShadow: `inset 0 1px 3px ${faded("shade", 18)}`,
} as const;

/** A paper slip's shadow on the cork, at rest and lifted under the pointer. */
export const SLIP_SHADOW = {
	lift: `drop-shadow(0 1px 1px ${faded("shade", 22)}) drop-shadow(0 6px 10px ${faded("shade", 16)})`,
	rest: `drop-shadow(0 1px 1px ${faded("shade", 20)}) drop-shadow(0 3px 5px ${faded("shade", 10)})`,
} as const;

/** The push pin's own shadow and the shine on its head. */
export const PIN_INK = {
	shadow: faded("shade", 30),
	shine: faded("paper", 75),
} as const;

/** The act layer's Market props: your stall at the cross, parcels, the counter crate. */
export const MARKET_ACT_ART = {
	/** The slate frame round each wait timer at the cross. */
	chalkboard: "#3d4a44",
	crate: "#b07a45",
	parcel: "#c99a5b",
	parcelString: "#e8d9b8",
	pipDone: "#e0904a",
	pipEstimate: "#f2c48f",
	pipTodo: "#e8dcc8",
	stallCloth: "#d9605a",
	stallTop: "#b98552",
	stallWood: "#8c5f3c",
	shutter: "#9aa3a8",
	shutterRib: "#7d868c",
} as const;
