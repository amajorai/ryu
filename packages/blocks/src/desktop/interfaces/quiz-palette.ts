import type { CSSProperties } from "react";

/**
 * Quiz Show art: the studio diorama's colours, and the board, its tiles and
 * the gold values on the plain board and the clue cards. Game art is allowed
 * its own palette (this is the one file in the Quiz Show where literal
 * colours live); the HUD comes from the game kit and the answer sheet's body
 * stays on the theme. The board is the classic deep broadcast blue in both
 * moods; the studio follows the theme's day or night.
 */
/** The board, its gold and ink, and the cards' screen. */
const SHARED = {
	"--quiz-board": "oklch(0.4 0.2 265)",
	"--quiz-board-top": "oklch(0.47 0.2 264)",
	"--quiz-board-low": "oklch(0.33 0.18 266)",
	"--quiz-frame": "oklch(0.13 0.04 268)",
	"--quiz-bezel": "oklch(0.24 0.06 268)",
	"--quiz-bezel-rim": "oklch(0.62 0.1 250)",
	"--quiz-off": "oklch(0.2 0.08 266)",
	"--quiz-played": "oklch(0.24 0.1 266)",
	"--quiz-tile-hover": "oklch(0.5 0.21 263)",
	"--quiz-gold": "oklch(0.86 0.15 88)",
	"--quiz-gold-deep": "oklch(0.62 0.13 70)",
	"--quiz-ink": "oklch(0.98 0.005 266)",
	"--quiz-ink-muted": "oklch(0.98 0.005 266 / 0.84)",
	"--quiz-ink-faint": "oklch(0.98 0.005 266 / 0.5)",
	"--quiz-lamp-off": "oklch(0.98 0.005 266 / 0.18)",
	"--quiz-lit-edge": "oklch(0.92 0.12 92)",
	"--quiz-lit-glow": "oklch(0.86 0.15 88 / 0.3)",
	"--quiz-shade": "oklch(0 0 0 / 0.45)",
};

/** Inline custom properties for the stage root. */
export const QUIZ_STAGE_VARS = SHARED as CSSProperties;

/** A tile's face: lit from above, deeper at the foot, like a backlit panel. */
export const TILE_FACE =
	"linear-gradient(180deg, var(--quiz-board-top) 0%, var(--quiz-board) 45%, var(--quiz-board-low) 100%)";

/** The board's bezel: a dark frame with a thin lit rim and a cast shadow. */
export const BOARD_BEZEL =
	"0 0 0 2px var(--quiz-bezel-rim), 0 0 0 12px var(--quiz-bezel), 0 0 0 14px var(--quiz-frame), 0 30px 60px -20px oklch(0 0 0 / 0.7)";

/**
 * Broadcast type for categories, values, scores and the round: a condensed
 * grotesk where the system has one (macOS, Windows, Android, and the common
 * Linux narrow faces), falling back to the theme's heading face. No
 * condensed face ships with the app, so big figures also set their own tight
 * tracking (`BROADCAST_FIGURES`) and read narrow on any fallback.
 */
export const QUIZ_BROADCAST_TYPE =
	"[font-family:'Avenir_Next_Condensed','Bahnschrift_SemiCondensed','Roboto_Condensed','Arial_Narrow','Liberation_Sans_Narrow','DejaVu_Sans_Condensed','Nimbus_Sans_Narrow',var(--font-heading),'Helvetica_Neue',sans-serif] [font-stretch:condensed]";

/** The tile whose conversation is open in the answer booth: a gold inner border. */
export const IN_PLAY_EDGE = "inset 0 0 0 4px var(--quiz-gold)";

/** A clue that needs the user: a crisp gold inner edge and a soft inner glow. */
export const LIT_EDGE =
	"inset 0 0 0 3px var(--quiz-lit-edge), inset 0 0 28px var(--quiz-lit-glow)";

/** A raised tile: a bright top edge, lit sides and a deep shade at its foot. */
export const TILE_BEVEL =
	"inset 0 2px 0 oklch(1 0 0 / 0.22), inset 2px 0 0 oklch(1 0 0 / 0.06), inset -2px 0 0 oklch(0 0 0 / 0.18), inset 0 -4px 0 var(--quiz-shade)";

/** A played square: pressed into the board, no lit edge. */
export const PLAYED_BEVEL =
	"inset 0 3px 6px oklch(0 0 0 / 0.45), inset 0 -1px 0 oklch(1 0 0 / 0.05)";

/** Tracking for large broadcast figures (values, scores): tight on any face. */
export const BROADCAST_FIGURES = "tabular-nums tracking-[-0.04em]";

/**
 * Centred figures (tile values, podium scores) are drawn a little narrow,
 * so they read as broadcast numerals even where no condensed face is
 * installed (most Linux desktops fall back to a regular grotesk).
 */
export const NARROW_FIGURES = "inline-block origin-center scale-x-[0.88]";

/** Category names: a hard drop and a soft halo, so caps lift off the tile. */
export const CATEGORY_SHADOW =
	"0 2px 0 var(--quiz-shade), 0 0 12px oklch(0 0 0 / 0.3)";

/** Gold values: a hard dark drop, like stage lettering. */
export const VALUE_SHADOW =
	"0 3px 0 var(--quiz-frame), 0 0 18px oklch(0 0 0 / 0.35)";

/** A podium front's lit edge and shaded sides. */
export const PODIUM_FRONT_SHADOW =
	"inset 0 2px 0 oklch(1 0 0 / 0.12), inset 3px 0 0 oklch(1 0 0 / 0.06), inset -3px 0 0 oklch(0 0 0 / 0.25)";

/** The podium desk's lit top and the shadow it casts on the front. */
export const PODIUM_DESK_SHADOW =
	"inset 0 1px 0 oklch(1 0 0 / 0.35), 0 3px 0 oklch(0 0 0 / 0.35)";

/** The score screen's backlight. */
export const SCREEN_GLOW = "inset 0 0 14px oklch(0.5 0.2 265 / 0.5)";

/** Score figures glow like a lit display. */
export const SCORE_GLOW = "0 0 10px oklch(0.7 0.15 260 / 0.8)";

/** A working podium's lamp halo. */
export const LAMP_GLOW = "0 0 8px var(--quiz-gold)";

/** The effects above as custom properties, set on the stage beside the colours. */
export const QUIZ_EFFECT_VARS = {
	"--quiz-category-shadow": CATEGORY_SHADOW,
	"--quiz-desk-shadow": PODIUM_DESK_SHADOW,
	"--quiz-lamp-glow": LAMP_GLOW,
	"--quiz-podium-front-shadow": PODIUM_FRONT_SHADOW,
	"--quiz-score-glow": SCORE_GLOW,
	"--quiz-screen-glow": SCREEN_GLOW,
	"--quiz-value-shadow": VALUE_SHADOW,
} as CSSProperties;

/** The studio diorama's colours (linear-light conversion happens in the kit). */
export const QUIZ_3D = {
	/** The glossy studio floor, its light pools, the stage and its ring. */
	floor: "#262a63",
	floorNight: "#181b48",
	pool: "#fff0c0",
	ring: "#f2c84b",
	stage: "#3b4fb8",
	/** The board wall: its bezel and the lit rim round it. */
	bezel: "#151a40",
	rim: "#7aa8ff",
	/** Tile faces by state: top and foot of the face, its bevel, its value. */
	tile: { bevel: "#7d97ff", foot: "#1d33b8", ink: "#ffd24a", top: "#3a5cff" },
	tileLit: {
		bevel: "#fff3b0",
		foot: "#2340d8",
		ink: "#fff6c8",
		top: "#4f72ff",
	},
	tilePlayed: {
		bevel: "#2a3778",
		foot: "#121a52",
		ink: "#55639e",
		top: "#1b2668",
	},
	tileInPlay: {
		bevel: "#fff6d0",
		foot: "#d9a51c",
		ink: "#2a1d05",
		top: "#ffd84d",
	},
	tileOff: {
		bevel: "#1d2560",
		foot: "#0e1440",
		ink: "#0e1440",
		top: "#141b4c",
	},
	/** The lit category headers. */
	header: { bevel: "#a9bbff", foot: "#2a46e0", ink: "#ffffff", top: "#4a6bff" },
	/** The curved backdrop and its marquee bulbs. */
	backdrop: "#2d2470",
	backdropNight: "#1f1a52",
	bulb: "#ffe29a",
	/** Podiums: body, desk, the lit score screen and its figures. */
	podium: "#3a55c8",
	podiumDesk: "#d8b46a",
	screen: "#0f1640",
	screenInk: "#ffd84d",
	lampOn: "#ffd84d",
	lampOff: "#3a3f6a",
	/** The act layer: progress pips on a podium front (lit, unlit, estimated). */
	pipDone: "#ffd84d",
	pipTodo: "#3a3f6a",
	pipEstimate: "#9fb4ff",
	/** The clue card a contestant carries to the lectern. */
	clueCard: "#2f49d0",
	/** The shot clock beside a contestant at the lectern. */
	shotClock: "#ff6a3d",
	/** A stopped run's buzzer: a red X lit on the podium. */
	buzzerX: "#ff3b3b",
	/** The sitting-out chair beside the stage. */
	chairSeat: "#c23a5a",
	chairFrame: "#3a2a2a",
	/** The host's lectern. */
	lectern: "#c8423a",
	/** Lighting truss, lamp housings and the beams they throw. */
	truss: "#5a5f78",
	lamp: "#2a2d3c",
	beam: "#fff2c0",
	/** Theatre seats: velvet and frame. */
	velvet: "#b8343a",
	seatFrame: "#3a2a2e",
} as const;
