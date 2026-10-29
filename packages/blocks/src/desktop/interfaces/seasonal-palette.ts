/**
 * Seasonal art: the colours of the three dioramas (the night pumpkin patch,
 * the snowy advent square and the lantern festival street). Game art may
 * carry its own palette (this is the one file in the Seasonal board where
 * literal colours live); the HUD and the gift card use the game kit and the
 * theme's semantic tokens and never read these.
 */

/** The dioramas' colours (linear-light conversion happens in the kit). */
export const SEASON_3D = {
	halloween: {
		/** The patch's ploughed rows, the furrows between and the vines. */
		soil: "#5a3f37",
		furrow: "#46302c",
		vine: "#3f7a3a",
		leaf: "#4f9443",
		/** A conversation's pumpkin, an empty place's pale gourd, the stem. */
		pumpkin: "#f07a22",
		pumpkinOpened: "#f39a3a",
		gourd: "#a9b59a",
		stem: "#5b7a2e",
		/** The carved face's light, and the glow round one that needs you. */
		face: "#ffc24a",
		faceHot: "#fff1a0",
		/** The scarecrow: post, shirt, hat and straw. */
		post: "#6b4a33",
		shirt: "#7a4bb0",
		hat: "#3b2a3f",
		straw: "#e4c35a",
		/** Bare trees, hay bales and the fence. */
		bark: "#3e3142",
		hay: "#d9b25a",
	},
	advent: {
		/** Snow on the ground and on roofs; the trodden square. */
		snow: "#f4f7fb",
		snowNight: "#b9c3dc",
		square: "#dfe5ee",
		squareNight: "#9aa4c2",
		/** The advent house: walls, timber, roof and chimney. */
		wall: "#f2d7a8",
		timber: "#7a4a32",
		roof: "#b8443f",
		chimney: "#9a5b48",
		/** Doors and window shutters, closed, by place (cycled). */
		shutters: ["#c0392f", "#2f7d55", "#2b5ca8", "#c58a1d"],
		/** A shutter that has nothing behind it yet. */
		shutterEmpty: "#cbbfa8",
		/** The painted number plaques on the doors. */
		plaque: "#fffaf0",
		plaqueEdge: "#5a3424",
		plaqueInk: "#2a120a",
		/** The lit room behind an opened door or window. */
		glow: "#ffd47a",
		/** The square's tree: needles, star and its lights. */
		needles: "#2f6e4a",
		star: "#ffd84d",
		bulbs: ["#ff6b5a", "#ffd84d", "#7ad7ff", "#9cff8a"],
		/** Cottages round the square: walls cycled, and their roofs. */
		cottages: ["#e9d3c0", "#d9e3ef", "#efe0b8"],
		cottageRoof: "#6e7f9c",
		/** The snowman: body, scarf, nose and coal. */
		snowman: "#ffffff",
		scarf: "#d8473f",
		nose: "#f08a2a",
		coal: "#2a2a35",
		/** Pines dusted with snow. */
		pines: ["#3b7a5c", "#2f6a50", "#4a8a68"],
	},
	"lunar-new-year": {
		/** The street's paving and its kerb. */
		paving: "#c9a68a",
		pavingNight: "#7f6a74",
		kerb: "#9c7a64",
		/** Shophouses: walls cycled, red pillars, roof tiles, gold trim. */
		walls: ["#f3e3c4", "#f0d6b8", "#e9dcc8"],
		pillar: "#c2302b",
		roof: "#2f5a5a",
		roofTiles: "#3f7a72",
		trim: "#e2b13c",
		/** Market stalls' awnings (cycled) and counters. */
		awnings: ["#d8473f", "#e2b13c", "#d8473f", "#3f8a6a"],
		counter: "#8a5a3a",
		/** Wires and poles. */
		wire: "#3a2a24",
		pole: "#7a2a24",
		/** A conversation's lantern, an opened one, an empty place's. */
		lantern: "#e0342b",
		lanternOpened: "#ffb43a",
		lanternEmpty: "#e8d9c0",
		lanternCap: "#e2b13c",
		/** The light inside a lit lantern, and the bright bloom of one that needs you. */
		glow: "#ffcf6a",
		hot: "#ffb067",
	},
} as const;

/**
 * The act layer's colours per season (spec §5, seasonal row): the
 * garland pips, the candle that stands for a queued ask's wait, the wrapped
 * gift set down as a deliverable, the mailbox (or cauldron, or post box)
 * at the you-spot, what covers a stopped run's place (frost on a door,
 * a cobweb over a pumpkin, a lantern gone dark), the helpers' dress (elves,
 * the scarecrow's helpers, festival helpers: shirt, collar and hat accent) and
 * tomorrow's door for a scheduled run (a little door, an uncarved pumpkin,
 * an unlit lantern: its body and trim).
 */
export const SEASON_ACT_ART = {
	advent: {
		cover: "#cfe8ff",
		coverEdge: "#ffffff",
		gift: "#c0392f",
		giftRibbon: "#ffd84d",
		pipDone: "#2f8a52",
		pipEstimate: "#ffd84d",
		pipTodo: "#d6dbe3",
		post: "#c0392f",
		postTrim: "#ffd84d",
		runner: "#7a4a32",
		timer: "#c0392f",
		elfAccent: "#c0392f",
		elfBody: "#2f8a52",
		elfCollar: "#ffffff",
		nextDoor: "#2f7d55",
		nextDoorTrim: "#ffd84d",
	},
	halloween: {
		cover: "#e6e2f0",
		coverEdge: "#ffffff",
		gift: "#f07a22",
		giftRibbon: "#3b2a3f",
		pipDone: "#f07a22",
		pipEstimate: "#ffc24a",
		pipTodo: "#6b5a70",
		post: "#2a2530",
		postTrim: "#5bd96a",
		runner: "#3e3142",
		timer: "#7a4bb0",
		elfAccent: "#3b2a3f",
		elfBody: "#7a4bb0",
		elfCollar: "#e4c35a",
		nextDoor: "#c98a4a",
		nextDoorTrim: "#5b7a2e",
	},
	"lunar-new-year": {
		cover: "#3a2a2e",
		coverEdge: "#1f1517",
		gift: "#e0342b",
		giftRibbon: "#e2b13c",
		pipDone: "#e0342b",
		pipEstimate: "#e2b13c",
		pipTodo: "#e8d9c0",
		post: "#2f7d55",
		postTrim: "#e2b13c",
		runner: "#7a2a24",
		timer: "#c2302b",
		elfAccent: "#e2b13c",
		elfBody: "#c2302b",
		elfCollar: "#e2b13c",
		nextDoor: "#e8d9c0",
		nextDoorTrim: "#e2b13c",
	},
} as const;
