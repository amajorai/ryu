import type { CSSProperties } from "react";

/**
 * Passport art: the cover board, the cream visa paper, foil, and stamp inks.
 * Game art may carry its own palette, but every color here is folded toward
 * the user's theme (a few percent of its primary and background), so the
 * booklet sits inside the theme instead of on top of it. The pages stay cream
 * in dark themes (a navy booklet with cream pages, like the real thing), so
 * text on paper uses the paper inks below, never the theme's foreground.
 * Chrome around the booklet uses the theme's semantic tokens directly.
 */

const CREAM = "#f4e9cf";
const NAVY = "#1b2944";
const GOLD = "#c9a660";
const INK = "#262e3d";

/**
 * Cream, nudged toward the theme's primary and only 2% toward its background,
 * so it stays cream (not grey) under a dark theme.
 */
const PAPER = `color-mix(in oklab, color-mix(in oklab, ${CREAM} 97%, var(--primary)) 98%, var(--background))`;
const PAGE_INK = `color-mix(in oklab, ${INK} 88%, var(--primary))`;
const COVER = `color-mix(in oklab, ${NAVY} 86%, var(--primary))`;
const FOIL = `color-mix(in oklab, ${GOLD} 88%, var(--warning))`;

/**
 * Stamp inks, deep enough to read on cream and spread around the wheel: a
 * blue, an oxblood, a leaf green, a violet, a slate, and an umber, each
 * pulled a little toward the theme. The order matters: `SIMILAR_INKS` in
 * passport-model.ts names the pairs that read alike by index.
 */
export const STAMP_INKS: readonly string[] = [
	"#24468f",
	"#8f2f3a",
	"#3d6b1f",
	"#5b3a8c",
	"#46505e",
	"#7a4c1f",
].map((ink) => `color-mix(in oklab, ${ink} 84%, var(--primary))`);

export function stampInk(index: number): string {
	return STAMP_INKS[index % STAMP_INKS.length] ?? PAGE_INK;
}

/**
 * A stamp ink lifted for the app's own chrome (the map, the record): half
 * ink, half the theme's foreground, so the glyph keeps its hue but reads on
 * a dark background as well as a light one. Raw ink belongs on paper only.
 */
export function chromeInk(index: number): string {
	return `color-mix(in oklab, ${stampInk(index)} 55%, var(--foreground))`;
}

/** The overprint for a refused entry: the theme's destructive, deepened. */
export const DENIED_INK = "color-mix(in oklab, var(--destructive) 82%, black)";

/** Custom properties the booklet sets once; parts read them as `var(--pp-*)`. */
export const PASSPORT_VARS = {
	"--pp-cover": COVER,
	"--pp-cover-edge": `color-mix(in oklab, ${COVER} 72%, black)`,
	"--pp-cover-ink": `color-mix(in oklab, ${COVER} 80%, black)`,
	"--pp-denied": DENIED_INK,
	"--pp-foil": FOIL,
	"--pp-foil-shade": `color-mix(in oklab, ${FOIL} 55%, black)`,
	"--pp-guilloche": `color-mix(in oklab, ${PAGE_INK} 9%, transparent)`,
	"--pp-ink": PAGE_INK,
	"--pp-ink-muted": `color-mix(in oklab, ${PAGE_INK} 72%, ${CREAM})`,
	"--pp-paper": PAPER,
	"--pp-paper-shade": `color-mix(in oklab, ${PAPER} 90%, ${INK})`,
	"--pp-rule": `color-mix(in oklab, ${PAGE_INK} 16%, transparent)`,
	"--pp-watermark": `color-mix(in oklab, ${PAGE_INK} 5.5%, transparent)`,
	"--pp-wash": `color-mix(in oklab, ${PAGE_INK} 5%, transparent)`,
} as CSSProperties;

/**
 * The desk's printed pages (passport-page-face.tsx): the booklet's inks
 * pressed darker, the muted ink and the rules most, since the camera reads
 * the page from a low angle and at a small size.
 */
export const DESK_FACE_VARS = {
	...PASSPORT_VARS,
	"--pp-ink": `color-mix(in oklab, ${INK} 94%, var(--primary))`,
	"--pp-ink-muted": `color-mix(in oklab, ${PAGE_INK} 90%, ${CREAM})`,
	"--pp-rule": `color-mix(in oklab, ${PAGE_INK} 36%, transparent)`,
} as CSSProperties;

/**
 * The booklet resting on the desk: a hairline drawn in the theme's
 * foreground (dark on a light desk, light on a dark one; stronger in dark
 * themes through `--pp-edge`) so the navy board always has an edge, a foil bevel just inside it, a contact shadow, and a
 * soft drop.
 */
export const BOOKLET_SHADOW =
	"0 0 0 1px color-mix(in oklab, var(--foreground) var(--pp-edge, 16%), transparent), inset 0 0 0 1px color-mix(in oklab, var(--pp-foil) 24%, transparent), 0 1px 2px color-mix(in oklab, black 22%, transparent), 0 18px 40px -18px color-mix(in oklab, black 45%, transparent)";

/** The fold: paper darkens a little into the spine on each page. */
export const GUTTER_LEFT = `linear-gradient(270deg, color-mix(in oklab, ${INK} 13%, transparent), transparent 28px)`;
export const GUTTER_RIGHT = `linear-gradient(90deg, color-mix(in oklab, ${INK} 13%, transparent), transparent 28px)`;

/** Shade that sweeps over a page while it turns. */
export const TURN_SHADE = `color-mix(in oklab, ${INK} 22%, transparent)`;

/** Foil that reads as pressed into the board, not printed on it. */
export const EMBOSS =
	"0 1px 0 color-mix(in oklab, white 14%, transparent), 0 -1px 0 color-mix(in oklab, black 45%, transparent)";

/**
 * The desk diorama's colours, on top of the game kit's shared scene palette
 * (`game3d-palette.ts`): the desk and its blotter, the booklet's navy boards
 * and cream pages, each country's index tab (its stamp ink, unmixed: three.js
 * takes plain hex), and the customs desk. Day and night (the night set dims
 * the wood and paper; the lamp glows).
 */
export interface DeskArt {
	/** The leather blotter the booklet lies on. */
	blotter: string;
	/** The customs desk: its wood and its top. */
	counter: string;
	counterTop: string;
	/** The booklet's boards and the gold foil on them. */
	cover: string;
	coverEdge: string;
	desk: string;
	deskGrain: string;
	foil: string;
	/** The page block's edge (the paper seen from the side). */
	pageEdge: string;
	/** The page's face under the printing. */
	paper: string;
	/** The leaf that turns, seen from its back. */
	paperBack: string;
	/** The clip strip behind the booklet, where the back tabs' notes ride. */
	strip: string;
	/** The unassigned pages' tab. */
	tabPlain: string;
	/** Each country's index tab, by its stamp ink index. */
	tabs: readonly string[];
}

/** The stamp inks unmixed, in `STAMP_INKS` order, for the index tabs. */
const TAB_INKS = [
	"#2f56a8",
	"#a33a46",
	"#4b7f29",
	"#6c48a3",
	"#5a6472",
	"#8e5a26",
] as const;

export const PASSPORT_DESK: DeskArt = {
	blotter: "#3f6e5c",
	counter: "#9b6a43",
	counterTop: "#c79a6a",
	cover: "#22345a",
	coverEdge: "#17243f",
	desk: "#c08a58",
	deskGrain: "#ad7848",
	foil: "#d6b36a",
	pageEdge: "#e8dcc0",
	paper: "#f6eed9",
	paperBack: "#eee3c8",
	strip: "#2f5748",
	tabPlain: "#8c8676",
	tabs: TAB_INKS,
};

export const PASSPORT_DESK_NIGHT: DeskArt = {
	blotter: "#294a3f",
	counter: "#6a4a33",
	counterTop: "#8c6a4b",
	cover: "#1a2847",
	coverEdge: "#101a30",
	desk: "#7d5b40",
	deskGrain: "#6d4f37",
	foil: "#c8a75f",
	pageEdge: "#cdbfa2",
	paper: "#efe5cc",
	paperBack: "#d9ccb0",
	strip: "#1e3a30",
	tabPlain: "#6d685c",
	tabs: TAB_INKS,
};

/** The cover setting: the stock navy, or another booklet colour. */
export type PassportCover = "black" | "burgundy" | "green" | "navy";

/**
 * The other covers: the board's base (folded toward the theme like the
 * navy) and the desk's boards by day and by night.
 */
const COVER_PRESETS: Record<
	Exclude<PassportCover, "navy">,
	{
		base: string;
		day: Pick<DeskArt, "cover" | "coverEdge">;
		night: Pick<DeskArt, "cover" | "coverEdge">;
	}
> = {
	black: {
		base: "#1f2024",
		day: { cover: "#26272c", coverEdge: "#18191c" },
		night: { cover: "#1d1e22", coverEdge: "#121315" },
	},
	burgundy: {
		base: "#5a1f2b",
		day: { cover: "#6a2433", coverEdge: "#4a1823" },
		night: { cover: "#521c28", coverEdge: "#36121a" },
	},
	green: {
		base: "#1f4434",
		day: { cover: "#24513d", coverEdge: "#173a2b" },
		night: { cover: "#1c3f30", coverEdge: "#122a20" },
	},
};

/** The desk's art by day or night, the booklet's boards in the cover setting. */
export function deskArt(
	night: boolean,
	cover: PassportCover = "navy"
): DeskArt {
	const art = night ? PASSPORT_DESK_NIGHT : PASSPORT_DESK;
	if (cover === "navy") {
		return art;
	}
	const preset = COVER_PRESETS[cover];
	return { ...art, ...(night ? preset.night : preset.day) };
}

/** The booklet's custom properties with its boards in the cover setting. */
export function passportVars(cover: PassportCover): CSSProperties {
	if (cover === "navy") {
		return PASSPORT_VARS;
	}
	const board = `color-mix(in oklab, ${COVER_PRESETS[cover].base} 86%, var(--primary))`;
	return {
		...PASSPORT_VARS,
		"--pp-cover": board,
		"--pp-cover-edge": `color-mix(in oklab, ${board} 72%, black)`,
		"--pp-cover-ink": `color-mix(in oklab, ${board} 80%, black)`,
	} as CSSProperties;
}

/** A country's tab colour by its ink index, wrapping. */
export function tabInk(art: DeskArt, index: number): string {
	return art.tabs[Math.abs(index) % art.tabs.length] ?? art.tabPlain;
}

/**
 * The act layer's desk props: the customs desk lamp, the ask slips and their
 * seals, the DENIED stamp block, the stamped page an answer is set down as,
 * and the ink pips.
 */
export const PASSPORT_ACT_ART = {
	/** The lamp's bulb with no ask waiting. */
	bulb: "#fff4cf",
	lampShade: "#2f6f5a",
	lampStand: "#3a3f47",
	page: "#f6efdc",
	pipDone: "#3f5f9c",
	pipEstimate: "#9db3dc",
	pipTodo: "#e6dccb",
	sealAmber: "#e0a22e",
	sealRed: "#c8402f",
	/** The ask slip: a visa form waiting for your signature. */
	slip: "#fbf6ea",
	slipRule: "#9aa3ad",
	/** The stamp block's wooden handle. */
	stampHandle: "#8a5236",
	/** The frame round each queued slip's wait timer (a fountain-pen blue). */
	timer: "#2f4f8f",
} as const;
