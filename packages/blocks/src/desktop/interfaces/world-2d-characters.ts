import type { WorldDirection } from "@ryuhq/protocol/interfaces";
import { agentHue } from "./interface-renderer.ts";
import { SV_QUEST, SWATCH } from "./world-2d-palette.ts";
import {
	hslPercentToHex,
	light,
	mix,
	PixelBuffer,
	type Sprite,
	shade,
	spriteCache,
	toSprite,
} from "./world-2d-pixel.ts";
import { characterLook } from "./world-2d-sprites.tsx";

/**
 * Stardew-proportioned villagers, 16x32 art pixels: a big head with hair,
 * two-pixel eyes with a highlight, a shirt, pants and shoes. Bodies are
 * palette-indexed maps; hair styles, legs and arms are layered per direction
 * and walk frame, then the whole figure gets a hue-shifted selective outline.
 */

// Palette keys: s skin, S skin shade, r blush, m mouth, e eye, w eye white,
// h hair, H hair shade, L hair light, t shirt, T shirt shade, c shirt light,
// p pants, P pants shade, b shoes, y/Y/l/R straw hat. Shirt shades shift
// toward purple (see `shade`), never toward black.

const BODY_DOWN = [
	"................",
	"................",
	"................",
	"......ssss......",
	"....ssssssss....",
	"...ssssssssss...",
	"...ssssssssss...",
	"...ssssssssss...",
	"...ssssssssss...",
	"..sssssssssssS..",
	"..sswessssewsS..",
	"..sssessssessS..",
	"...srssssssrS...",
	"...ssssmmsssS...",
	"....sssssssS....",
	".....SSSSSS.....",
	"......SSSS......",
	"....tcccccct....",
	"..cttttttttttT..",
	"..tttttttttttT..",
	"..tTttttttttTT..",
	"..tTttttttttTT..",
	"..sTttttttttTS..",
	"..sTTTTTTTTTTS..",
	"...pppppppppP...",
	"...ppppPPpppP...",
] as const;

const BODY_UP = [
	"................",
	"................",
	"................",
	"......ssss......",
	"....ssssssss....",
	"...ssssssssss...",
	"...ssssssssss...",
	"...ssssssssss...",
	"...ssssssssss...",
	"..sssssssssssS..",
	"..sssssssssssS..",
	"..sssssssssssS..",
	"...sssssssssS...",
	"...ssssssssSS...",
	"....SSSSSSSS....",
	".....SSSSSS.....",
	"......SSSS......",
	"....tttttttt....",
	"..cttttttttttT..",
	"..tttttttttttT..",
	"..tTttttttttTT..",
	"..tTttttttttTT..",
	"..sTttttttttTS..",
	"..sTTTTTTTTTTS..",
	"...pppppppppP...",
	"...pppppppppP...",
] as const;

const BODY_RIGHT = [
	"................",
	"................",
	"................",
	"......ssss......",
	".....ssssss.....",
	"....ssssssss....",
	"....sssssssss...",
	"....sssssssss...",
	"....sssssssss...",
	"....ssssssssss..",
	"....sssssssess..",
	"....sssssssess..",
	"....ssssssssrs..",
	"....ssssssssm...",
	".....Ssssssss...",
	"......SSSSSS....",
	".......SSS......",
	".....tcccct.....",
	"....tttttttT....",
	"....tttttttT....",
	"....tttttttT....",
	"....tttttttT....",
	"....tttttttT....",
	"....TTTTTTTT....",
	"....pppppppP....",
	"....pppppppP....",
] as const;

const HAIR_DOWN = [
	"................",
	"................",
	".....hhhhhh.....",
	"....hhhhhhhh....",
	"...hLLhhhhhhh...",
	"..hLLhhhhhhhhH..",
	"..hhhhhhhhhhhH..",
	"..hhhhhhhhhhHH..",
	"..hhh.hhhh.hHH..",
	"..hh........HH..",
	"..h..........H..",
	"..H..........H..",
] as const;

const HAIR_UP = [
	"................",
	"................",
	".....hhhhhh.....",
	"....hhhhhhhh....",
	"...hhLLhhhhhh...",
	"..hhLLhhhhhhhH..",
	"..hhhhhhhhhhhH..",
	"..hhhhhhhhhhhH..",
	"..hhhhhhhhhhHH..",
	"..hhhhhhhhhhHH..",
	"..hhhhhhhhhhHH..",
	"..hhhhhhhhhhHH..",
	"...HhhhhhhhhH...",
	"....HHHHHHHH....",
] as const;

const HAIR_RIGHT = [
	"................",
	"................",
	"......hhhh......",
	".....hhhhhh.....",
	"....hhhLLhhh....",
	"...hhhLLhhhhh...",
	"...hhhhhhhhhhh..",
	"...hhhhhhhhh.h..",
	"...hhhhhh.......",
	"...hhhhh........",
	"...hhhh.........",
	"...Hhhh.........",
	"...HHh..........",
] as const;

const HAT_DOWN = [
	"................",
	"......llll......",
	".....lyyyyy.....",
	"....lyyyyyyY....",
	"....yyyYyyyY....",
	"....RRRRRRRR....",
	".lyyyyyyyyyyyyY.",
	".YYYYYYYYYYYYYY.",
] as const;

const HAT_UP = [
	"................",
	"......llll......",
	".....lyyyyy.....",
	"....lyyyYyyY....",
	"....yyyyyyyY....",
	"....RRRRRRRR....",
	".lyyyyyyyyyyyyY.",
	".YYYYYYYYYYYYYY.",
] as const;

const HAT_RIGHT = [
	"................",
	"......llll......",
	".....lyyyyY.....",
	".....yyYyyY.....",
	".....yyyyyY.....",
	".....RRRRRR.....",
	"..lyyyyyyyyyyyY.",
	"..YYYYYYYYYYYYY.",
] as const;

type Facing = WorldDirection;

type Garment = "overalls" | "shirt" | "vest";

interface Look {
	eye: string;
	garment: Garment;
	hair: string;
	hairStyle: number;
	hat: boolean;
	pants: string;
	shirt: string;
	shoes: string;
	skin: string;
	skinShade: string;
	vest: string;
}

/**
 * Muted, warm Stardew shirts, picked by the agent's place in the village so
 * the first ten never repeat and none is the lawn's green.
 */
const SHIRTS = [
	SWATCH.cyan595,
	SWATCH.yellow480,
	SWATCH.fuchsia575,
	SWATCH.orange540,
	SWATCH.blue530,
	SWATCH.rose400,
	SWATCH.yellow225,
	SWATCH.green505,
	SWATCH.violet400,
	SWATCH.red585,
] as const;

const PANTS = [
	SWATCH.blue575,
	SWATCH.orange710,
	SWATCH.blue690,
	SWATCH.violet580,
	SWATCH.amber645,
	SWATCH.coolGrey660,
] as const;

const GARMENTS: readonly Garment[] = [
	"shirt",
	"shirt",
	"overalls",
	"shirt",
	"vest",
	"shirt",
	"vest",
	"overalls",
	"shirt",
	"vest",
];

const VESTS = [
	SWATCH.orange675,
	SWATCH.blue690,
	SWATCH.amber645,
	SWATCH.fuchsia700,
] as const;

/**
 * Hair styles: 0 short, 1 long, 2 spiky, 3 bun, 4 bob, 5 ponytail.
 * The first ten villagers get a curated style and color each, so
 * neighbors in the village (and in the hotbar) never share a silhouette
 * or a hair color.
 */
const HAIR_STYLE_COUNT = 6;
const CURATED_HAIR = [
	{ color: SWATCH.amber420, style: 3 },
	{ color: SWATCH.orange725, style: 5 },
	{ color: SWATCH.orange525, style: 1 },
	{ color: SWATCH.orange875, style: 2 },
	{ color: SWATCH.orange605, style: 4 },
	{ color: SWATCH.indigo720, style: 0 },
	{ color: SWATCH.amber215, style: 5 },
	{ color: SWATCH.orange875, style: 4 },
	{ color: SWATCH.amber420, style: 2 },
	{ color: SWATCH.orange725, style: 1 },
] as const;

/**
 * Agent look: the 2D sprite matches the 3D villager's hair and skin; the
 * outfit comes from `index` (the agent's place in the village), or from the
 * agent's hue when it has none or is past the tenth.
 */
export function agentLook(agentId: string, index = -1): Look {
	const look = characterLook(agentId);
	let hash = 0;
	for (const char of agentId) {
		hash = (hash * 17 + (char.codePointAt(0) ?? 0)) % 9973;
	}
	const curated = index >= 0 && index < SHIRTS.length;
	const slot = curated ? index : hash;
	const hair = curated ? CURATED_HAIR[index] : undefined;
	return {
		eye: SWATCH.purple855,
		garment: GARMENTS[slot % GARMENTS.length] ?? "shirt",
		hair: hair?.color ?? look.hair,
		hairStyle: hair?.style ?? (look.hairStyle + hash) % HAIR_STYLE_COUNT,
		hat: false,
		pants: PANTS[(slot * 5 + 1) % PANTS.length] ?? SWATCH.blue575,
		shirt: curated
			? (SHIRTS[index] ?? SHIRTS[0])
			: hslPercentToHex(agentHue(agentId), 44, 54),
		shoes: SWATCH.orange785,
		skin: look.skin.fill,
		skinShade: look.skin.shade,
		vest: VESTS[slot % VESTS.length] ?? SWATCH.orange675,
	};
}

/** The farmer: straw hat, red shirt, blue overalls. */
export const PLAYER_LOOK: Look = {
	eye: SWATCH.purple855,
	garment: "overalls",
	hair: SWATCH.orange690,
	hairStyle: 0,
	hat: true,
	pants: SWATCH.blue550,
	shirt: SWATCH.red480,
	shoes: SWATCH.orange715,
	skin: SWATCH.amber155Muted,
	skinShade: SWATCH.orange280,
	vest: SWATCH.orange675,
};

/** Overalls bib and straps, or an open vest, over the shirt. */
function drawGarment(
	buffer: PixelBuffer,
	look: Look,
	facing: Facing,
	pal: Record<string, string>,
	ox: number,
	oy: number
): void {
	if (look.garment === "shirt") {
		return;
	}
	const rect = (x: number, y: number, w: number, h: number, color: string) =>
		buffer.rect(ox + x, oy + y, w, h, color);
	if (look.garment === "overalls") {
		const p = pal.p ?? SWATCH.black990;
		const P = pal.P ?? SWATCH.black990;
		if (facing === "down") {
			rect(5, 17, 1, 3, p);
			rect(10, 17, 1, 3, P);
			rect(5, 20, 6, 4, p);
			rect(10, 20, 1, 4, P);
			buffer.set(ox + 5, oy + 20, SWATCH.yellow285);
			buffer.set(ox + 10, oy + 20, SWATCH.yellow480);
		} else if (facing === "up") {
			rect(5, 17, 1, 5, p);
			rect(10, 17, 1, 5, P);
			rect(4, 22, 8, 2, p);
		} else {
			rect(7, 17, 1, 3, p);
			rect(6, 20, 5, 4, p);
			rect(10, 20, 1, 4, P);
		}
		return;
	}
	const v = look.vest;
	const vShade = shade(v, 0.25);
	if (facing === "down") {
		rect(2, 18, 4, 6, v);
		rect(10, 18, 4, 6, vShade);
		rect(5, 18, 1, 6, light(v, 0.2));
	} else if (facing === "up") {
		rect(2, 18, 12, 6, v);
		rect(11, 18, 3, 6, vShade);
	} else {
		rect(4, 18, 5, 6, v);
		rect(8, 18, 1, 6, light(v, 0.2));
	}
}

function lookPalette(look: Look): Record<string, string> {
	return {
		b: look.shoes,
		c: light(look.shirt, 0.28),
		e: look.eye,
		h: look.hair,
		H: shade(look.hair, 0.3),
		L: light(look.hair, 0.3),
		l: SWATCH.yellow195,
		m: mix(look.skinShade, SWATCH.red535, 0.45),
		p: look.pants,
		P: shade(look.pants, 0.28),
		R: SWATCH.red525,
		r: mix(look.skin, SWATCH.red250, 0.4),
		S: look.skinShade,
		s: look.skin,
		T: shade(look.shirt, 0.3),
		t: look.shirt,
		w: SWATCH.white10Muted,
		Y: SWATCH.amber525,
		y: SWATCH.amber365Muted,
	};
}

/** Extra hair for the long, spiky, bun, bob and ponytail styles. */
function styleHair(
	buffer: PixelBuffer,
	style: number,
	facing: Facing,
	pal: Record<string, string>,
	ox: number,
	oy: number
): void {
	const h = pal.h ?? SWATCH.black990;
	const H = pal.H ?? SWATCH.black990;
	const set = (x: number, y: number, color: string) =>
		buffer.set(ox + x, oy + y, color);
	if (style === 1) {
		// Long hair down to the shoulders.
		if (facing === "down") {
			for (let y = 11; y < 19; y++) {
				set(2, y, h);
				set(3, y, y > 16 ? H : h);
				set(12, y, H);
				set(13, y, H);
			}
		} else if (facing === "up") {
			for (let y = 12; y < 20; y++) {
				for (let x = 3; x < 13; x++) {
					set(x, y, x > 10 || y === 19 ? H : h);
				}
			}
		} else {
			for (let y = 9; y < 19; y++) {
				set(3, y, H);
				set(4, y, h);
				set(5, y, y < 15 ? h : H);
			}
		}
	} else if (style === 2) {
		// Spiky top.
		for (const [x, y] of [
			[5, 1],
			[7, 0],
			[8, 1],
			[10, 1],
			[4, 2],
			[11, 2],
		] as const) {
			set(facing === "right" ? x + 1 : x, y, h);
		}
		if (facing === "down") {
			set(6, 9, h);
			set(9, 9, h);
		}
	} else if (style === 3) {
		// A bun on top (front/back) or at the back of the head (side).
		if (facing === "right") {
			buffer.ellipse(ox + 3, oy + 5, 2.2, 2.2, H);
		} else {
			buffer.ellipse(ox + 8, oy + 1.5, 2.6, 2, facing === "up" ? h : H);
		}
	} else if (style === 4) {
		// A bob: blunt bangs and hair falling straight to the jaw.
		if (facing === "down") {
			for (let x = 3; x < 13; x++) {
				set(x, 8, x > 10 ? H : h);
			}
			for (let y = 9; y < 14; y++) {
				set(2, y, h);
				set(3, y, y === 13 ? H : h);
				set(12, y, H);
				set(13, y, H);
			}
		} else if (facing === "up") {
			for (let y = 12; y < 15; y++) {
				for (let x = 2; x < 14; x++) {
					set(x, y, x > 10 || y === 14 ? H : h);
				}
			}
		} else {
			for (let y = 8; y < 14; y++) {
				set(3, y, H);
				set(4, y, h);
				set(5, y, y < 12 ? h : H);
				set(6, y, y < 10 ? h : H);
			}
		}
	} else if (style === 5) {
		// A high ponytail swinging out behind the head.
		if (facing === "down") {
			for (const [x, y] of [
				[1, 4],
				[0, 5],
				[1, 5],
				[0, 6],
				[1, 6],
				[0, 7],
				[0, 8],
				[1, 9],
			] as const) {
				set(x, y, x === 0 && y > 6 ? H : h);
			}
		} else if (facing === "up") {
			for (let y = 12; y < 18; y++) {
				set(7, y, h);
				set(8, y, H);
			}
			set(7, 11, SWATCH.red430);
			set(8, 11, SWATCH.red430);
		} else {
			for (const [x, y] of [
				[2, 4],
				[1, 5],
				[2, 5],
				[1, 6],
				[0, 7],
				[1, 7],
				[0, 8],
				[1, 9],
			] as const) {
				set(x, y, y > 6 ? H : h);
			}
			set(3, 5, SWATCH.red430);
		}
	}
}

/**
 * Legs, shoes and swinging arm for one walk frame. Frames 1 and 3 are the
 * strides; 0 and 2 stand.
 */
function drawLegs(
	buffer: PixelBuffer,
	facing: Facing,
	frame: number,
	pal: Record<string, string>,
	ox: number,
	oy: number
): void {
	const p = pal.p ?? SWATCH.black990;
	const P = pal.P ?? SWATCH.black990;
	const b = pal.b ?? SWATCH.black990;
	const rect = (x: number, y: number, w: number, h: number, color: string) =>
		buffer.rect(ox + x, oy + y, w, h, color);
	if (facing === "down" || facing === "up") {
		const leftLift = frame === 1 ? 1 : 0;
		const rightLift = frame === 3 ? 1 : 0;
		rect(4, 25, 2, 4 - leftLift, p);
		rect(6, 25, 1, 4 - leftLift, P);
		rect(4, 29 - leftLift, 3, 2, b);
		rect(9, 25, 2, 4 - rightLift, p);
		rect(11, 25, 1, 4 - rightLift, P);
		rect(9, 29 - rightLift, 3, 2, b);
		return;
	}
	if (frame === 1 || frame === 3) {
		const far = frame === 1 ? P : p;
		const near = frame === 1 ? p : P;
		// Back leg.
		rect(4, 25, 3, 4, far);
		rect(3, 29, 4, 2, shade(b, 0.15));
		// Front leg.
		rect(8, 25, 3, 4, near);
		rect(9, 29, 4, 2, b);
		return;
	}
	rect(6, 25, 4, 4, p);
	rect(6, 25, 1, 4, P);
	rect(6, 29, 5, 2, b);
}

function drawSideArm(
	buffer: PixelBuffer,
	frame: number,
	pal: Record<string, string>,
	ox: number,
	oy: number
): void {
	const swing = frame === 1 ? 1 : frame === 3 ? -1 : 0;
	const t = pal.t ?? SWATCH.black990;
	const T = pal.T ?? SWATCH.black990;
	buffer.rect(ox + 6, oy + 18, 3, 3, t);
	buffer.rect(ox + 6 + swing, oy + 21, 3, 2, t);
	buffer.vline(ox + 6 + swing, oy + 21, 2, T);
	buffer.rect(ox + 6 + swing, oy + 23, 3, 1, pal.s ?? SWATCH.black990);
	buffer.rect(ox + 7 + swing, oy + 24, 2, 1, pal.S ?? SWATCH.black990);
}

/** Width/height of a character buffer: 16x32 plus a 1px outline margin. */
const CHAR_W = 18;
const CHAR_H = 34;

/**
 * Builds one character frame. `breathe` lowers the upper body a pixel for the
 * idle bob. The sprite's anchor is the bottom center of its tile.
 */
function buildCharacter(
	look: Look,
	facing: Facing,
	frame: number,
	breathe: boolean
): Sprite {
	const buffer = new PixelBuffer(CHAR_W, CHAR_H);
	const pal = lookPalette(look);
	const flip = facing === "left";
	const dir: Facing = flip ? "right" : facing;
	const ox = 1;
	// Stride frames bob the body up a pixel; breathing lowers it one.
	const bob = (frame === 1 || frame === 3 ? -1 : 0) + (breathe ? 1 : 0);
	const oy = 1;
	const layer = new PixelBuffer(CHAR_W, CHAR_H);
	drawLegs(layer, dir, frame, pal, ox, oy);
	const upper = new PixelBuffer(CHAR_W, CHAR_H);
	const body = dir === "down" ? BODY_DOWN : dir === "up" ? BODY_UP : BODY_RIGHT;
	upper.map(body, pal, ox, oy);
	drawGarment(upper, look, dir, pal, ox, oy);
	if (dir === "right") {
		drawSideArm(upper, frame, pal, ox, oy);
	}
	if (look.hat) {
		const hair =
			dir === "down" ? HAIR_DOWN : dir === "up" ? HAIR_UP : HAIR_RIGHT;
		upper.map(hair.slice(6), pal, ox, oy + 6);
		const hat = dir === "down" ? HAT_DOWN : dir === "up" ? HAT_UP : HAT_RIGHT;
		upper.map(hat, pal, ox, oy);
	} else {
		const hair =
			dir === "down" ? HAIR_DOWN : dir === "up" ? HAIR_UP : HAIR_RIGHT;
		upper.map(hair, pal, ox, oy);
		styleHair(upper, look.hairStyle, dir, pal, ox, oy);
	}
	if (
		dir === "down" &&
		!look.hat &&
		look.hairStyle !== 1 &&
		look.hairStyle !== 4
	) {
		// Ears peek out under short hair.
		upper.set(ox + 2, oy + 10, pal.s ?? SWATCH.black990);
		upper.set(ox + 13, oy + 10, pal.S ?? SWATCH.black990);
	}
	layer.blit(upper, 0, bob);
	layer.outline(0.58);
	buffer.blit(layer, 0, 0, flip);
	return toSprite(buffer, CHAR_W / 2, CHAR_H);
}

const characterSprites = spriteCache(buildCharacter);

function lookKey(look: Look): string {
	return `${look.hair}|${look.hairStyle}|${look.hat}|${look.pants}|${look.shirt}|${look.skin}|${look.garment}|${look.vest}`;
}

/** One frame of a character, cached per look/direction/frame. */
export function characterSprite(
	look: Look,
	facing: Facing,
	frame: number,
	breathe = false
): Sprite {
	return characterSprites(
		`${lookKey(look)}|${facing}|${frame}|${breathe}`,
		look,
		facing,
		frame,
		breathe
	);
}

/**
 * The Stardew "..." emote: a white bubble whose dots fill in one by one,
 * with a short tail pointing straight down at the villager. `dots` is 0..3.
 * The anchor is the tail's tip.
 */
/** The emote bubble's body and tail, empty (15x12). */
function bubbleBody(): PixelBuffer {
	const w = 15;
	const h = 12;
	const buffer = new PixelBuffer(w, h);
	const outline = SWATCH.purple795;
	const fill = SWATCH.yellow20;
	const shadeFill = SWATCH.violet135;
	// Rounded body.
	buffer.hline(2, 0, 11, outline);
	buffer.rect(1, 1, 13, 7, outline);
	buffer.hline(2, 8, 11, outline);
	buffer.set(0, 2, outline);
	buffer.rect(0, 2, 1, 5, outline);
	buffer.rect(14, 2, 1, 5, outline);
	buffer.hline(2, 1, 11, fill);
	buffer.rect(1, 2, 13, 5, fill);
	buffer.hline(2, 7, 11, shadeFill);
	buffer.set(13, 6, shadeFill);
	// Tail: one pixel wide, pointing down at the head.
	buffer.rect(6, 8, 3, 1, fill);
	buffer.set(5, 8, outline);
	buffer.set(9, 8, outline);
	buffer.set(6, 9, outline);
	buffer.set(8, 9, outline);
	buffer.set(7, 9, fill);
	buffer.set(7, 10, outline);
	return buffer;
}

function buildBubble(dots: number): Sprite {
	const buffer = bubbleBody();
	for (let i = 0; i < dots; i++) {
		buffer.rect(3 + i * 4, 3, 2, 2, SWATCH.purple720);
		buffer.set(3 + i * 4, 3, SWATCH.coolGrey525);
	}
	return toSprite(buffer, 7, 11);
}

const bubbleSprites = spriteCache(buildBubble);

export function bubbleSprite(dots: number): Sprite {
	return bubbleSprites(String(dots), dots);
}

/** Which "!" a villager wears: amber for your turn, red for trouble. */
export type QuestTone = "attention" | "your-turn";

const QUEST_INK: Record<QuestTone, { fill: string; shade: string }> = {
	attention: SV_QUEST.attention,
	"your-turn": SV_QUEST.yourTurn,
};

/**
 * Stardew's "!" emote for a villager who is waiting on the player: a white
 * bubble like the "..." emote's, taller and narrower, holding a chunky
 * exclamation mark. o outline, f fill, d fill shade, F/S the mark and its
 * shade. The anchor is the tail's tip.
 */
const QUEST_BUBBLE = [
	"..ooooooo..",
	".offfffffo.",
	"offfFFSfffo",
	"offfFFSfffo",
	"offfFFSfffo",
	"offfFFSfffo",
	"offffFSfffo",
	"offfffffffo",
	"offfFFSfffo",
	"offfFFSfffo",
	".odddddddo.",
	"..oofffoo..",
	"....ofo....",
	".....o.....",
] as const;

function buildQuestBubble(tone: QuestTone): Sprite {
	const { fill, shade } = QUEST_INK[tone];
	const keys: Record<string, string> = {
		d: SV_QUEST.bubbleShade,
		F: fill,
		f: SV_QUEST.bubbleFill,
		o: SV_QUEST.outline,
		S: shade,
	};
	const width = QUEST_BUBBLE[0].length;
	const buffer = new PixelBuffer(width, QUEST_BUBBLE.length);
	QUEST_BUBBLE.forEach((row, y) => {
		for (let x = 0; x < row.length; x++) {
			const color = keys[row[x] ?? "."];
			if (color) {
				buffer.set(x, y, color);
			}
		}
	});
	return toSprite(buffer, 5, QUEST_BUBBLE.length - 1);
}

const questSprites = spriteCache(buildQuestBubble);

export function questMarkerSprite(tone: QuestTone): Sprite {
	return questSprites(tone, tone);
}

/** A soft pixel shadow under a character. */
function buildCharacterShadow(): Sprite {
	const buffer = new PixelBuffer(14, 5);
	buffer.ellipse(7, 2.5, 6.5, 2.4, SWATCH.green880A33);
	buffer.ellipse(7, 2.5, 4.5, 1.6, SWATCH.green880A13);
	return toSprite(buffer, 7, 3);
}

let shadowSprite: Sprite | null = null;

export function characterShadow(): Sprite {
	shadowSprite ??= buildCharacterShadow();
	return shadowSprite;
}

/**
 * Head-and-shoulders crop of a character facing the viewer, for portraits
 * and hotbar slots. Returns the source canvas and crop rectangle.
 */
export function portraitCrop(
	agentId: string | null,
	rows: "bust" | "head",
	index = -1
): { canvas: HTMLCanvasElement; h: number; w: number; x: number; y: number } {
	const look = agentId ? agentLook(agentId, index) : PLAYER_LOOK;
	const sprite = characterSprite(look, "down", 0);
	return rows === "head"
		? { canvas: sprite.canvas, h: 18, w: 18, x: 0, y: 0 }
		: { canvas: sprite.canvas, h: 26, w: 18, x: 0, y: 0 };
}

// ---------------------------------------------------------------------------
// Dialogue portraits
// ---------------------------------------------------------------------------

/** Size of a dialogue portrait in art pixels. */
export const PORTRAIT_SIZE = 48;

/**
 * Hair for a portrait: a cap of hair over the crown with a lit band and
 * bangs, then the style's extra (long locks, spikes, or a bun).
 */
function portraitHair(
	buffer: PixelBuffer,
	look: Look,
	pal: Record<string, string>
): void {
	const h = pal.h ?? SWATCH.black990;
	const H = pal.H ?? SWATCH.black990;
	const L = pal.L ?? SWATCH.black990;
	if (look.hairStyle === 1) {
		// Long hair falls past the ears to the shoulders on both sides.
		buffer.rect(9, 12, 5, 26, H);
		buffer.rect(34, 12, 5, 26, H);
		buffer.rect(10, 12, 3, 24, h);
		buffer.rect(35, 12, 2, 24, h);
	} else if (look.hairStyle === 4) {
		// A bob: straight sides cut level with the jaw.
		buffer.rect(9, 12, 6, 18, H);
		buffer.rect(33, 12, 6, 18, H);
		buffer.rect(10, 12, 4, 17, h);
		buffer.rect(34, 12, 3, 17, h);
	} else if (look.hairStyle === 5) {
		// A ponytail swinging out behind the head, tied with a red band.
		buffer.ellipse(7, 22, 4, 10, H);
		buffer.ellipse(7.5, 20, 2.6, 8, h);
		buffer.rect(8, 10, 4, 3, SWATCH.red430);
	}
	// The crown: a cap over the top of the head down to the brow line.
	for (let y = 2; y < 18; y++) {
		for (let x = 8; x < 41; x++) {
			const dx = (x + 0.5 - 24) / 14;
			const dy = (y + 0.5 - 14) / 11.5;
			if (dx * dx + dy * dy > 1) {
				continue;
			}
			// Above the brows the cap covers everything; lower it only
			// frames the face at the temples.
			const temple = x < 13 || x > 34;
			if (y >= 14 && !temple) {
				continue;
			}
			buffer.set(x, y, x > 31 || y > 15 ? H : h);
		}
	}
	// Bangs: uneven locks hanging over the forehead.
	for (let x = 13; x < 35; x++) {
		const lock = (x * 7 + look.hairStyle * 3) % 5;
		// The bob's bangs are cut straight across.
		const length = look.hairStyle === 4 ? 3 : lock < 2 ? 3 : lock === 4 ? 1 : 2;
		buffer.vline(x, 14, length, x > 30 ? H : h);
	}
	// Sideburns past the ears.
	buffer.rect(11, 16, 2, 6, h);
	buffer.rect(35, 16, 2, 6, H);
	// A lit band across the crown (light from the top-left).
	for (let x = 14; x < 28; x++) {
		const y = 5 + Math.round(Math.abs(x - 19) * 0.3);
		buffer.set(x, y, L);
		if (x % 4 !== 0) {
			buffer.set(x, y + 1, L);
		}
	}
	if (look.hairStyle === 2) {
		for (const [x, y] of [
			[13, 3],
			[18, 1],
			[24, 0],
			[29, 1],
			[33, 4],
		] as const) {
			buffer.rect(x, y, 3, 4, h);
			buffer.set(x + 1, y - 1, h);
		}
	} else if (look.hairStyle === 3) {
		buffer.ellipse(24, 3, 6, 4, H);
		buffer.ellipse(23.4, 2.6, 4.6, 2.8, h);
		buffer.hline(21, 1, 3, L);
	}
}

/** The straw hat for the player's portrait. */
function portraitHat(buffer: PixelBuffer, pal: Record<string, string>): void {
	const y = pal.y ?? SWATCH.black990;
	const Y = pal.Y ?? SWATCH.black990;
	const l = pal.l ?? SWATCH.black990;
	buffer.ellipse(24, 10, 10, 7, y);
	buffer.rect(14, 10, 20, 5, y);
	buffer.hline(15, 13, 18, pal.R ?? SWATCH.black990);
	buffer.hline(15, 14, 18, pal.R ?? SWATCH.black990);
	buffer.ellipse(24, 17, 21, 3.4, y);
	buffer.hline(5, 18, 38, Y);
	buffer.hline(8, 19, 32, Y);
	buffer.hline(18, 5, 8, l);
	buffer.hline(16, 6, 4, l);
	for (let x = 7; x < 42; x += 3) {
		buffer.set(x, 16, Y);
	}
}

/**
 * A Stardew-style dialogue bust, 48x48: a big head with hair, large eyes
 * with a highlight, brows, blush and a mouth that smiles when idle and
 * presses into a thinking line (with a sideways glance) while working, over
 * shoulders in the villager's outfit.
 */
function buildPortrait(look: Look, working: boolean): Sprite {
	const size = PORTRAIT_SIZE;
	const buffer = new PixelBuffer(size, size);
	const pal = lookPalette(look);
	const s = pal.s ?? SWATCH.black990;
	const S = pal.S ?? SWATCH.black990;
	const t = pal.t ?? SWATCH.black990;
	const T = pal.T ?? SWATCH.black990;
	const c = pal.c ?? SWATCH.black990;
	// Shoulders and torso.
	buffer.ellipse(24, 47, 20, 11, t);
	buffer.rect(4, 42, 40, 6, t);
	for (let y = 36; y < 48; y++) {
		for (let x = 0; x < size; x++) {
			if (buffer.alpha(x, y) === 0) {
				continue;
			}
			if (x > 33) {
				buffer.set(x, y, T);
			} else if (x < 12 && y < 44) {
				buffer.set(x, y, c);
			}
		}
	}
	if (look.garment === "overalls") {
		buffer.rect(15, 38, 3, 10, pal.p ?? SWATCH.black990);
		buffer.rect(30, 38, 3, 10, pal.P ?? SWATCH.black990);
		buffer.rect(17, 43, 14, 5, pal.p ?? SWATCH.black990);
		buffer.set(16, 43, SWATCH.yellow285);
		buffer.set(31, 43, SWATCH.yellow480);
	} else if (look.garment === "vest") {
		buffer.rect(8, 40, 9, 8, look.vest);
		buffer.rect(31, 40, 9, 8, shade(look.vest, 0.25));
		buffer.vline(16, 40, 8, light(look.vest, 0.2));
	}
	// Collar: an open V of skin with the shirt's light edge.
	buffer.rect(20, 34, 8, 3, S);
	for (let i = 0; i < 4; i++) {
		buffer.hline(21 + i, 37 + i, 6 - i * 2, S);
	}
	buffer.set(19, 36, c);
	buffer.set(28, 36, c);
	// Neck.
	buffer.rect(20, 29, 8, 6, s);
	buffer.rect(25, 29, 3, 6, S);
	// Head.
	buffer.ellipse(24, 20, 12.5, 12.5, s);
	buffer.rect(13, 20, 22, 7, s);
	buffer.ellipse(24, 27, 10, 5.5, s);
	for (let y = 10; y < 33; y++) {
		for (let x = 30; x < 38; x++) {
			if (buffer.alpha(x, y) > 0 && x > 33 - (y > 26 ? (y - 26) * 0.6 : 0)) {
				buffer.set(x, y, S);
			}
		}
	}
	buffer.hline(18, 32, 12, S);
	// Ears.
	buffer.rect(10, 20, 3, 6, s);
	buffer.set(11, 22, S);
	buffer.rect(35, 20, 3, 6, S);
	if (look.hat) {
		portraitHair(buffer, { ...look, hairStyle: 0 }, pal);
		portraitHat(buffer, pal);
	} else {
		portraitHair(buffer, look, pal);
	}
	// Brows.
	const H = pal.H ?? SWATCH.black990;
	buffer.hline(16, 18 + (working ? 1 : 0), 5, H);
	buffer.hline(27, 18, 5, H);
	// Eyes: tall dark ovals with a white highlight; glancing aside at work.
	const glance = working ? 1 : 0;
	for (const ex of [17, 28]) {
		buffer.rect(ex, 21, 3, 4, pal.e ?? SWATCH.black990);
		buffer.hline(ex + 1, 20, 1, pal.e ?? SWATCH.black990);
		buffer.set(ex + glance, 21, SWATCH.white10Muted);
		buffer.set(
			ex + 2,
			24,
			mix(pal.e ?? SWATCH.black990, SWATCH.violet465, 0.5)
		);
	}
	// Nose and blush.
	buffer.set(24, 25, S);
	buffer.set(23, 26, S);
	const blush = pal.r ?? SWATCH.black990;
	buffer.hline(14, 27, 3, blush);
	buffer.hline(31, 27, 3, blush);
	// Mouth.
	const mouth = pal.m ?? SWATCH.black990;
	if (working) {
		buffer.hline(22, 29, 4, mouth);
	} else {
		buffer.hline(21, 29, 1, mouth);
		buffer.hline(22, 30, 4, mouth);
		buffer.hline(26, 29, 1, mouth);
		buffer.set(23, 31, mix(mouth, s, 0.5));
	}
	// A deep warm-brown line all round, as Stardew's portraits have.
	buffer.outline(0.55, false, SWATCH.rose820);
	return toSprite(buffer, 0, 0);
}

const portraitSprites = spriteCache(buildPortrait);

/** The dialogue bust of an agent (or the player, for `null`). */
export function portraitSprite(
	agentId: string | null,
	index: number,
	working: boolean
): Sprite {
	const look = agentId ? agentLook(agentId, index) : PLAYER_LOOK;
	return portraitSprites(`${lookKey(look)}|${working}`, look, working);
}
