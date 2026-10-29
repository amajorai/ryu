/**
 * Card Table art: the felt, the padded rail, chips and card backs, and the
 * card room diorama's colours. Game art is allowed its own palette (this is the
 * one file in the Card Table where literal colours live). The flat spread's
 * colours are mixed from the user's theme tokens (shaded toward black for
 * depth), so its baize follows the theme's success hue, the rail its card
 * surface and the chips its accents; the room uses the shared 3D kit's fixed
 * art colours. Chrome and text never use these; they use the theme's semantic
 * tokens directly.
 *
 * Mixes are in OKLab, not OKLCH: a neutral like white has hue 0 in OKLCH, and
 * mixing a green into it there swings the hue through orange.
 */

/**
 * Felt: the theme's success hue with a third of its primary folded in, so the
 * baize takes on the theme (teal under a blue primary, plum-green under a
 * violet one), deepened, then lifted a little by the surface.
 */
const BAIZE = "color-mix(in oklab, var(--success) 68%, var(--primary))";
export const FELT_CENTER = `color-mix(in oklab, color-mix(in oklab, ${BAIZE} 74%, black) 84%, var(--background))`;
export const FELT_EDGE = `color-mix(in oklab, color-mix(in oklab, ${BAIZE} 50%, black) 90%, var(--background))`;

function feltGradient(center: string, edge: string): string {
	return `radial-gradient(ellipse 68% 64% at 50% 40%, ${center}, ${edge})`;
}

export const FELT_BACKGROUND = feltGradient(FELT_CENTER, FELT_EDGE);

/**
 * Felt for dark themes. Dark themes tend to pastel success and primary
 * colors, and shading a pastel toward black turns it grey, so here the baize
 * keeps the theme's hue but sets its lightness outright and holds a floor
 * under its chroma: a rich, deep green (or teal, or plum-green) that still
 * stands well apart from the rail and the page.
 */
export const FELT_CENTER_DARK = `oklch(from ${BAIZE} 0.44 clamp(0.08, c, 0.13) h)`;
export const FELT_EDGE_DARK = `oklch(from ${BAIZE} 0.3 clamp(0.06, c, 0.1) h)`;
export const FELT_BACKGROUND_DARK = feltGradient(
	FELT_CENTER_DARK,
	FELT_EDGE_DARK
);

/**
 * The padded rail around the felt: the card surface, shaded like leather. A
 * soft highlight falls on its top and a shade on its bottom, over the base
 * tone, so it reads as a rounded pad rather than a flat band.
 */
export const RAIL_BACKGROUND = [
	"linear-gradient(180deg, color-mix(in oklab, white 30%, transparent), transparent 40%)",
	"linear-gradient(0deg, color-mix(in oklab, black 22%, transparent), transparent 38%)",
	"linear-gradient(180deg, color-mix(in oklab, var(--card) 86%, var(--foreground)), color-mix(in oklab, var(--card) 70%, var(--foreground)))",
].join(", ");

/** Shadows the table casts, and the felt's recessed lip under the rail. */
export const TABLE_SHADOW =
	"0 30px 60px -26px color-mix(in oklab, black 55%, transparent), 0 10px 20px -12px color-mix(in oklab, black 35%, transparent)";
export const FELT_INSET =
	"inset 0 5px 22px color-mix(in oklab, black 55%, transparent), inset 0 1px 3px color-mix(in oklab, black 40%, transparent), inset 0 0 0 1px color-mix(in oklab, black 30%, transparent)";

/**
 * Chip faces, from the theme's accents. Red and green are left out on purpose:
 * on this table red means "needs attention" and green means "working", so a
 * chip in either would misreport a seat. The set is the primary, a neutral, an
 * amber, and two primary shifts (one toward the text color, one swung through
 * the far side of the hue wheel toward amber, which lands on a violet for a
 * blue primary and a blue for a green one), so stacks stay apart on any felt.
 */
export const CHIP_COLORS: readonly string[] = [
	"var(--primary)",
	"color-mix(in oklab, var(--foreground) 80%, var(--background))",
	"color-mix(in oklab, var(--warning) 92%, black)",
	"color-mix(in oklch longer hue, var(--primary) 62%, var(--warning))",
	"color-mix(in oklab, var(--primary) 52%, var(--foreground))",
];

/** The inlay color on a chip's edge and face. */
export const CHIP_INLAY = "color-mix(in oklab, white 86%, transparent)";

/** The thin light rim that keeps a chip apart from a felt of the same hue. */
export const CHIP_RIM = "color-mix(in oklab, white 55%, transparent)";

/** The hairline of shadow where one chip sits on the next. */
export const CHIP_SEAM = "color-mix(in oklab, black 45%, transparent)";

/** The soft shadow a chip stack drops on the felt. */
export const CHIP_DROP = "color-mix(in oklab, black 35%, transparent)";

/** The chip's side, seen below its face when chips are stacked. */
export function chipSide(color: string): string {
	return `color-mix(in oklab, ${color} 62%, black)`;
}

/**
 * A chip's edge as seen from the table: the side color broken by the light
 * inlays every real chip carries, repeating every `period` px. Stacked chips
 * shift the pattern (background-position) so they read as separate chips.
 */
export function chipEdge(color: string, period: number): string {
	const side = chipSide(color);
	const inlay = Math.max(2, Math.round(period * 0.24));
	return `repeating-linear-gradient(90deg, ${side} 0 ${period - inlay}px, ${CHIP_INLAY} ${period - inlay}px ${period}px)`;
}

/** A chip's top face: a solid center ring inside a band of edge inlays. */
export function chipFace(color: string): string {
	return `radial-gradient(closest-side, ${color} 0 50%, ${CHIP_INLAY} 51% 58%, ${color} 59% 100%)`;
}

/** Card backs: a fine lattice in the theme's primary over the card surface. */
export const CARD_BACK =
	"repeating-linear-gradient(45deg, color-mix(in oklab, var(--primary) 72%, black) 0 2px, color-mix(in oklab, var(--primary) 88%, white) 2px 4px), repeating-linear-gradient(-45deg, transparent 0 2px, color-mix(in oklab, black 18%, transparent) 2px 4px)";
export const CARD_BACK_BORDER = "color-mix(in oklab, white 92%, var(--card))";

/** The track behind a working agent's action timer. */
export const TIMER_TRACK =
	"color-mix(in oklab, var(--success) 35%, transparent)";

/**
 * The card room the table stands in: a warm lounge by day (light themes)
 * and a dim card room by night (dark themes), a carpet with a faint diamond
 * weave, lit by a lamp over the table. Exposed as custom properties the
 * room's `dark:` classes swap, so it follows the theme without reading it.
 */
const ROOM_DAY = {
	"--ct-room-l": "#6b3a2c",
	"--ct-room-deep-l": "#3f2119",
	"--ct-room-weave-l": "rgb(255 220 180 / 0.06)",
	"--ct-room-lamp-l": "rgb(255 214 150 / 0.42)",
};

const ROOM_NIGHT = {
	"--ct-room-d": "#2a1418",
	"--ct-room-deep-d": "#12080a",
	"--ct-room-weave-d": "rgb(255 200 170 / 0.04)",
	"--ct-room-lamp-d": "rgb(255 196 130 / 0.22)",
};

export const ROOM_VARS = { ...ROOM_DAY, ...ROOM_NIGHT } as Record<
	string,
	string
>;

export const ROOM_MODE =
	"[--ct-room:var(--ct-room-l)] [--ct-room-deep:var(--ct-room-deep-l)] [--ct-room-weave:var(--ct-room-weave-l)] [--ct-room-lamp:var(--ct-room-lamp-l)] dark:[--ct-room:var(--ct-room-d)] dark:[--ct-room-deep:var(--ct-room-deep-d)] dark:[--ct-room-weave:var(--ct-room-weave-d)] dark:[--ct-room-lamp:var(--ct-room-lamp-d)]";

export const ROOM_BACKGROUND = [
	"radial-gradient(ellipse 60% 55% at 50% 48%, var(--ct-room-lamp), transparent 70%)",
	"repeating-linear-gradient(45deg, var(--ct-room-weave) 0 2px, transparent 2px 22px)",
	"repeating-linear-gradient(-45deg, var(--ct-room-weave) 0 2px, transparent 2px 22px)",
	"radial-gradient(ellipse 90% 90% at 50% 45%, var(--ct-room), var(--ct-room-deep))",
].join(", ");

/** The padded rail in the room: dark leather with a warm sheen. */
export const RAIL_LEATHER = [
	"linear-gradient(180deg, rgb(255 255 255 / 0.22), transparent 40%)",
	"linear-gradient(0deg, rgb(0 0 0 / 0.3), transparent 38%)",
	"linear-gradient(180deg, #4a2a1d, #2a170f)",
].join(", ");

/**
 * Card stock: playing cards are paper in every theme. Set on a card (face,
 * mini face or pile edge), these re-point the theme tokens the card's parts
 * use, so the face is ivory with dark ink and a red suit by day and by night;
 * only the felt, the room and the plates change between the moods.
 */
export const CARD_STOCK = {
	"--border": "#d8cdb6",
	"--card": "#fbf7ee",
	"--card-foreground": "#1f1a14",
	"--destructive": "#c4262e",
	"--foreground": "#1f1a14",
	"--muted-foreground": "#6b6153",
	"--success": "#1f7a3c",
} as Record<string, string>;

/** The card room diorama's colours (linear-light conversion happens in the kit). */
export const CARD_ROOM_3D = {
	/** The floor's boards and the rug under the table. */
	floor: "#b07a4f",
	floorNight: "#7a5640",
	rug: "#8e2f2f",
	rugTrim: "#d8a64a",
	/** The walls, their wainscot and the skirting board. */
	wall: "#efe0c4",
	wainscot: "#5e3b2c",
	/** The table: felt, the leather rail, the wood under it and its post. */
	felt: "#2f7a55",
	feltLine: "#5fae84",
	rail: "#4a2a20",
	wood: "#7a4a32",
	/** Chairs: frames and cushions. */
	chair: "#6b3f2a",
	cushion: "#b8433a",
	/**
	 * Chips by seat (cycled). No red or green, as on the plain table: red
	 * means "needs attention" and green "working" here.
	 */
	chips: ["#2f78d0", "#e9a821", "#2b2b33", "#8a5ad0", "#ece4d2", "#24407a"],
	chipEdge: "#f4efe4",
	/** Cards: faces and backs. */
	cardFace: "#fbf7ee",
	cardBack: "#2f63c4",
	/** The lamp over the table: shade, cord, the bulb and its light. */
	shade: "#2f5a46",
	cord: "#2a2420",
	bulb: "#ffe3a0",
	light: "#fff1c8",
	/** Potted plants and picture frames on the walls. */
	pot: "#c0704a",
	frame: "#d8a64a",
	pictures: ["#7cc1d9", "#e88d7a", "#9ccf7c"],
} as const;

/** The act layer's card room props: the ask card's seal, progress chips, the pot. */
export const CARD_ACT_ART = {
	/** The dealer button and the sitting-out button: white pucks. */
	buttonFace: "#f7f3ea",
	buttonRim: "#2b2b33",
	/** The folded card's back (a stopped run lies face down). */
	foldBack: "#7a2f2a",
	/** The dealer's timer chip by a queued card. */
	timer: "#2b2b33",
	pipEstimate: "#f2d58a",
	pipGhost: "#cfd8cc",
	pipGold: "#e9a821",
	pipRed: "#c8402f",
	potChip: "#2f78d0",
} as const;

/** The felt setting: the stock baize (`classic`), or a named cloth. */
export type CardTableFelt = "blue" | "classic" | "red";

/** The deck setting: the stock backs (`classic`), or a named deck. */
export type CardTableDeck = "black" | "classic" | "red";

/**
 * The felt presets: the room's cloth and its line, and the flat spread's
 * baize by day and by night (`classic` keeps the theme-mixed baize above).
 */
export const FELT_PRESETS: Record<
	Exclude<CardTableFelt, "classic">,
	{ dark: string; light: string; room: string; roomLine: string }
> = {
	blue: {
		dark: feltGradient("#24557a", "#132f47"),
		light: feltGradient("#2f6c9a", "#1a4166"),
		room: "#2f6a96",
		roomLine: "#6ea6cf",
	},
	red: {
		dark: feltGradient("#6e2530", "#3d1219"),
		light: feltGradient("#8c2f3b", "#5a1a24"),
		room: "#8a2f3a",
		roomLine: "#c96a74",
	},
};

/** The deck presets: the room's card backs and the flat cards' back lattice. */
export const DECK_PRESETS: Record<
	Exclude<CardTableDeck, "classic">,
	{ back: string; room: string }
> = {
	black: {
		back: "repeating-linear-gradient(45deg, #1d1d22 0 2px, #45454f 2px 4px), repeating-linear-gradient(-45deg, transparent 0 2px, rgb(0 0 0 / 0.18) 2px 4px)",
		room: "#2b2b33",
	},
	red: {
		back: "repeating-linear-gradient(45deg, #8e1f26 0 2px, #c8434b 2px 4px), repeating-linear-gradient(-45deg, transparent 0 2px, rgb(0 0 0 / 0.18) 2px 4px)",
		room: "#b8323a",
	},
};

/** The flat cards' back for a deck setting. */
export function cardBackFor(deck: CardTableDeck): string {
	return deck === "classic" ? CARD_BACK : DECK_PRESETS[deck].back;
}

/** The room's felt, felt line and card backs for the settings. */
export function cardRoomCloth(
	felt: CardTableFelt,
	deck: CardTableDeck
): { cardBack: string; felt: string; feltLine: string } {
	const cloth = felt === "classic" ? null : FELT_PRESETS[felt];
	return {
		cardBack:
			deck === "classic" ? CARD_ROOM_3D.cardBack : DECK_PRESETS[deck].room,
		felt: cloth?.room ?? CARD_ROOM_3D.felt,
		feltLine: cloth?.roomLine ?? CARD_ROOM_3D.feltLine,
	};
}

/** The flat spread's baize (day, night) for a felt setting. */
export function spreadFelt(felt: CardTableFelt): {
	dark: string;
	light: string;
} {
	return felt === "classic"
		? { dark: FELT_BACKGROUND_DARK, light: FELT_BACKGROUND }
		: FELT_PRESETS[felt];
}
