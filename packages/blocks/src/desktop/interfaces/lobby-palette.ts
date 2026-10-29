/**
 * Lobby art: the menu backdrop, its light rays and floor, the character
 * bodies, and the plaza diorama's colours. Game art may keep its own palette
 * (this is the one file in the Lobby where literal colours live). The 2D
 * menu art is mixed from the user's theme tokens, so it follows the theme's
 * primary hue; the diorama uses the shared 3D kit's fixed art colours.
 * Chrome and text never use these; they use the theme's semantic tokens.
 *
 * Mixes are in OKLab: a neutral mixed in OKLCH swings its hue.
 */

import {
	ditherAvatarHue,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import type { CSSProperties } from "react";

/**
 * The stage set: a bright sky-blue arena by day (light themes) and a deep
 * indigo one by night (dark themes), as `--lobby-*` custom properties the
 * scene's `dark:` classes swap without reading the theme in JavaScript.
 */
const STAGE_DAY = {
	"--lobby-sky-top-l": "#3d8ff5",
	"--lobby-sky-l": "#7cc4ff",
	"--lobby-sky-low-l": "#d9f0ff",
	"--lobby-ray-l": "rgb(255 255 255 / 0.22)",
	"--lobby-floor-l": "rgb(255 255 255 / 0.75)",
	"--lobby-floor-edge-l": "#4f9fe8",
};

const STAGE_NIGHT = {
	"--lobby-sky-top-d": "#0b0f2e",
	"--lobby-sky-d": "#1d2668",
	"--lobby-sky-low-d": "#2b3a8f",
	"--lobby-ray-d": "rgb(140 170 255 / 0.12)",
	"--lobby-floor-d": "rgb(120 160 255 / 0.35)",
	"--lobby-floor-edge-d": "#5b7cff",
};

/** Inline custom properties for the stage. */
export const LOBBY_SCENE_VARS = {
	...STAGE_DAY,
	...STAGE_NIGHT,
} as CSSProperties;

/** Picks the day or night stage, so parts use the plain names. */
export const LOBBY_SCENE_MODE =
	"[--lobby-sky-top:var(--lobby-sky-top-l)] [--lobby-sky:var(--lobby-sky-l)] [--lobby-sky-low:var(--lobby-sky-low-l)] [--lobby-ray:var(--lobby-ray-l)] [--lobby-floor:var(--lobby-floor-l)] [--lobby-floor-edge:var(--lobby-floor-edge-l)] dark:[--lobby-sky-top:var(--lobby-sky-top-d)] dark:[--lobby-sky:var(--lobby-sky-d)] dark:[--lobby-sky-low:var(--lobby-sky-low-d)] dark:[--lobby-ray:var(--lobby-ray-d)] dark:[--lobby-floor:var(--lobby-floor-d)] dark:[--lobby-floor-edge:var(--lobby-floor-edge-d)]";

/** The arena backdrop: lit from the top centre, deepest at the top edge. */
export const STAGE_BACKGROUND = [
	"radial-gradient(ellipse 55% 45% at 50% 38%, var(--lobby-sky-low), transparent 75%)",
	"linear-gradient(180deg, var(--lobby-sky-top) 0%, var(--lobby-sky) 45%, var(--lobby-sky-low) 100%)",
].join(", ");

/** Light rays fanning out from behind the squad, faded out by a mask. */
export const STAGE_RAYS: CSSProperties = {
	background:
		"repeating-conic-gradient(from 0deg at 50% 46%, var(--lobby-ray) 0deg 4deg, transparent 4deg 12deg)",
	maskImage:
		"radial-gradient(ellipse 70% 70% at 50% 46%, black 15%, transparent 80%)",
};

/** The round platform the squad stands on. */
export const STAGE_FLOOR: CSSProperties = {
	background:
		"radial-gradient(ellipse 50% 50% at 50% 50%, var(--lobby-floor) 0%, var(--lobby-floor) 55%, var(--lobby-floor-edge) 58%, transparent 72%)",
};

/** The lit ring on the floor under the selected member. */
export const SELECTED_RING: CSSProperties = {
	background:
		"radial-gradient(ellipse 50% 50% at 50% 50%, transparent 52%, color-mix(in oklab, var(--primary) 85%, transparent) 56%, color-mix(in oklab, var(--primary) 30%, transparent) 64%, transparent 72%)",
};

/** The soft shadow a standee casts on the floor. */
export const FIGURE_SHADOW: CSSProperties = {
	background:
		"radial-gradient(ellipse 50% 50% at 50% 50%, color-mix(in oklab, var(--foreground) 28%, transparent), transparent 72%)",
};

/** The tinted backdrop of a roster tile or news art. */
export const TILE_BACKDROP = [
	"radial-gradient(ellipse 80% 70% at 50% 100%, color-mix(in oklab, var(--primary) 22%, transparent), transparent 70%)",
	"linear-gradient(180deg, color-mix(in oklab, var(--primary) 6%, var(--muted)), color-mix(in oklab, var(--primary) 14%, var(--muted)))",
].join(", ");

export interface FigureColors {
	/** Boots: the darkest part of the body. */
	boot: string;
	/** The eyes and mouth on the head's screen. */
	eye: string;
	/** The hands, and behind an avatar image on the head. */
	face: string;
	/** Body fill from the lit side to the shaded side. */
	lit: string;
	mid: string;
	/** The one-pixel outline around the whole sprite. */
	outline: string;
	pants: string;
	shade: string;
	/** Belt and collar trim. */
	trim: string;
	/** The head's screen, dark so the face reads. */
	visor: string;
}

/**
 * A character's body: the hue its avatar is drawn in, at a fixed saturation
 * and lightness, with a little of the theme's primary mixed in, so every
 * agent reads as a solid sprite that still sits in the theme.
 */
export function figureColors(
	agent: Pick<InterfaceAgent, "id" | "name">
): FigureColors {
	const hue = ditherAvatarHue(
		ditherAvatarSeed({ id: agent.id, name: agent.name })
	);
	const base = `color-mix(in oklab, hsl(${hue} 62% 56%) 90%, var(--primary))`;
	return {
		boot: `color-mix(in oklab, ${base} 22%, black)`,
		eye: `color-mix(in oklab, ${base} 30%, white)`,
		face: `color-mix(in oklab, ${base} 10%, white)`,
		lit: `color-mix(in oklab, ${base} 72%, white)`,
		mid: base,
		outline: `color-mix(in oklab, ${base} 34%, black)`,
		pants: `color-mix(in oklab, ${base} 42%, black)`,
		shade: `color-mix(in oklab, ${base} 74%, black)`,
		trim: `color-mix(in oklab, ${base} 30%, black)`,
		visor: `color-mix(in oklab, ${base} 16%, black)`,
	};
}

/** The plaza diorama's colours (linear-light conversion happens in the kit). */
export const LOBBY_3D = {
	/** The act layer: the ready-check ring and banner on the pad. */
	readyRing: "#ffd84d",
	readyBanner: "#e8384a",
	bannerPole: "#9aa3b2",
	/** A limited member's cooldown ring. */
	cooldown: "#ffb648",
	/** A member's console (its step and loading bar) and its screen. */
	consoleBody: "#3a3f5c",
	consoleScreen: "#7fd4ff",
	/** Party slots: lit for a running helper, dim when free, red when failed. */
	partyOn: "#7fe0a0",
	partyOff: "#5a5f78",
	partyFailed: "#ff5a4a",
	/** The plaza's paving, by day and by night, and the darker joint ring. */
	paving: "#e6d9c0",
	pavingNight: "#7d7894",
	pavingAlt: "#ddcdb0",
	pavingAltNight: "#75708c",
	pavingRing: "#cdbb9a",
	pavingRingNight: "#68627f",
	/** The podium: its tiers, the gold rim and the lit top. */
	podium: "#5f8fe8",
	podiumNight: "#4a5fc4",
	podiumStep: "#f4ecdb",
	podiumRim: "#ffc94a",
	podiumTop: "#fff6e2",
	podiumTopNight: "#c9d2ff",
	/** The light pillar over the podium. */
	spotlight: "#fff4c8",
	/** An open squad place: a ghost disc on the podium. */
	openSlot: "#cfe0ff",
	/** Boards: posts, the frame, the cork and the notes pinned to it. */
	boardPost: "#7a5235",
	boardFrame: "#9a6a43",
	boardCork: "#e2b981",
	notes: ["#fff3c4", "#ffd6d0", "#d4f0ff", "#dff5c8"],
	/** The play portal: its stone base, the gold ring and the glowing gate. */
	portalBase: "#b9b2c8",
	portalRing: "#ffc94a",
	portalGlow: "#7ad7ff",
	portalGlowNight: "#9a7bff",
	portalCore: "#e8fbff",
	/** Bunting strung round the podium. */
	bunting: ["#ef5a43", "#ffc94a", "#5aa6ff", "#56c271"],
} as const;
