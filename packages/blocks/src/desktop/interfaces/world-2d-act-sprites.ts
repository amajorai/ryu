import { WORLD_2D_ACT } from "./world-2d-palette.ts";
import {
	PixelBuffer,
	type Sprite,
	spriteCache,
	toSprite,
} from "./world-2d-pixel.ts";

/**
 * The act layer's pixel sprites for the 2D village: an hourglass plaque
 * with the wait ("14m"), a pips bar, a limit's zzz and clock, the chest of
 * answers, and the letter or scroll an asker carries. Built once per key.
 */

/** 3x5 glyphs for a wait: digits, the unit letters, "in", "<", "≤" and ":". */
const WAIT_GLYPHS: Readonly<Record<string, string>> = {
	"0": "111101101101111",
	"1": "010110010010111",
	"2": "111001111100111",
	"3": "111001111001111",
	"4": "101101111001001",
	"5": "111100111001111",
	"6": "111100111101111",
	"7": "111001001010010",
	"8": "111101111101111",
	"9": "111101111001111",
	d: "001001111101111",
	h: "100100111101101",
	m: "000110111101101",
	s: "000111110011110",
	"≤": "001010100010111",
	"<": "001010100010001",
	i: "010000010010010",
	n: "000110101101101",
	"~": "000010101000000",
	":": "000010000010000",
	" ": "000000000000000",
};

function waitText(buffer: PixelBuffer, text: string, x: number, y: number) {
	let cursor = x;
	for (const char of text) {
		const glyph = WAIT_GLYPHS[char] ?? WAIT_GLYPHS[" "] ?? "";
		for (let i = 0; i < 15; i++) {
			if (glyph[i] === "1") {
				buffer.set(cursor + (i % 3), y + Math.floor(i / 3), WORLD_2D_ACT.ink);
			}
		}
		cursor += 4;
	}
}

/** The wait in the glyphs this font has ("≤ 7m" → "≤7m"). */
export function waitGlyphs(text: string): string {
	// Spaces stay ("in 7m"), so a countdown never reads as an age.
	return [...text].filter((char) => char in WAIT_GLYPHS).join("");
}

/** How long an ask has waited (the protocol's `waitBand`). */
export type WaitTint =
	| "expiring"
	| "fresh"
	| "long"
	| "stale"
	| "unknown"
	| "waiting";

const WAIT_TINTS: Record<WaitTint, string> = {
	expiring: WORLD_2D_ACT.waitExpiring,
	fresh: WORLD_2D_ACT.waitFresh,
	long: WORLD_2D_ACT.waitLong,
	stale: WORLD_2D_ACT.waitStale,
	unknown: WORLD_2D_ACT.waitUnknown,
	waiting: WORLD_2D_ACT.waitWaiting,
};

function buildHourglass(text: string, tint: WaitTint): Sprite {
	const chars = [...text].length;
	const width = 10 + Math.max(0, chars * 4 - 1) + 2;
	const buffer = new PixelBuffer(width, 11);
	buffer.rect(1, 1, width - 2, 9, WAIT_TINTS[tint]);
	// The hourglass: frame, glass, sand settling in the bottom bulb.
	buffer.hline(2, 2, 5, WORLD_2D_ACT.outline);
	buffer.hline(2, 8, 5, WORLD_2D_ACT.outline);
	buffer.rect(3, 3, 3, 2, WORLD_2D_ACT.glass);
	buffer.set(4, 5, WORLD_2D_ACT.sand);
	buffer.rect(3, 6, 3, 2, WORLD_2D_ACT.sand);
	waitText(buffer, text, 9, 3);
	buffer.outline(0.55, false, WORLD_2D_ACT.outline);
	return toSprite(buffer, width, 11);
}

const hourglasses = spriteCache(buildHourglass);

/**
 * The hourglass plaque with the wait, anchored at its bottom-right, tinted
 * by how long the ask has waited.
 */
export function hourglassSprite(
	wait: string,
	tint: WaitTint = "fresh"
): Sprite {
	const text = waitGlyphs(wait);
	return hourglasses(`${tint}:${text}`, text, tint);
}

/** Pips shown at most; more scale into the bar's share. */
const MAX_PIPS = 8;

function buildPips(done: number, total: number): Sprite {
	const width = total * 3 + 1;
	const buffer = new PixelBuffer(width + 2, 5);
	buffer.rect(1, 1, width, 3, WORLD_2D_ACT.outline);
	for (let i = 0; i < total; i++) {
		buffer.rect(
			2 + i * 3,
			2,
			2,
			1,
			i < done ? WORLD_2D_ACT.pipDone : WORLD_2D_ACT.pipTodo
		);
	}
	return toSprite(buffer, Math.round((width + 2) / 2), 5);
}

const pipBars = spriteCache(buildPips);

/** A pixel bar of `total` pips (at most 8), `done` lit; anchored bottom-centre. */
export function pipBarSprite(done: number, total: number): Sprite {
	const shown = Math.min(MAX_PIPS, Math.max(1, total));
	const lit = Math.round((Math.min(done, total) / Math.max(1, total)) * shown);
	return pipBars(`${lit}/${shown}`, lit, shown);
}

function buildZzz(time: string): Sprite {
	const chars = [...time].length;
	const width = chars > 0 ? Math.max(16, 8 + chars * 4) : 16;
	const height = chars > 0 ? 15 : 13;
	const buffer = new PixelBuffer(width, height);
	// Three z's climbing to the right.
	for (const [x, y, s] of [
		[0, 8, 3],
		[4, 4, 4],
		[9, 0, 5],
	] as const) {
		buffer.hline(x, y, s, WORLD_2D_ACT.zzz);
		for (let i = 1; i < s - 1; i++) {
			buffer.set(x + s - 1 - i, y + i, WORLD_2D_ACT.zzz);
		}
		buffer.hline(x, y + s - 1, s, WORLD_2D_ACT.zzz);
	}
	// A small clock face below the z's.
	buffer.ellipse(3, 11, 2.2, 1.6, WORLD_2D_ACT.clockRim);
	buffer.set(3, 11, WORLD_2D_ACT.clockFace);
	// When it is back, beside the clock ("15:10"; "~" when estimated).
	// Under the middle z, so the z's stay whole.
	if (chars > 0) {
		buffer.rect(6, 9, chars * 4 + 1, 6, WORLD_2D_ACT.plaque);
		waitText(buffer, time, 7, 10);
	}
	buffer.outline(0.55, false, WORLD_2D_ACT.outline);
	return toSprite(buffer, 0, height);
}

const zzzs = spriteCache(buildZzz);

/**
 * A limit's zzz with its clock, anchored bottom-left; `back` is when it is
 * back ("15:10"), shown beside the clock when known.
 */
export function zzzSprite(back: string | null = null): Sprite {
	const time = back ? waitGlyphs(back).trim() : "";
	return zzzs(time, time);
}

function buildChest(): Sprite {
	const buffer = new PixelBuffer(12, 9);
	buffer.rect(1, 3, 10, 5, WORLD_2D_ACT.chest);
	buffer.rect(1, 1, 10, 2, WORLD_2D_ACT.chest);
	buffer.hline(1, 3, 10, WORLD_2D_ACT.chestBand);
	buffer.rect(5, 3, 2, 2, WORLD_2D_ACT.chestLock);
	buffer.outline(0.55, false, WORLD_2D_ACT.outline);
	return toSprite(buffer, 6, 9);
}

let chest: Sprite | null = null;

/** The chest of answers on your doorstep, anchored bottom-centre. */
export function chestSprite(): Sprite {
	chest ??= buildChest();
	return chest;
}

function buildCarry(kind: "letter" | "scroll"): Sprite {
	const buffer = new PixelBuffer(8, 6);
	if (kind === "letter") {
		buffer.rect(1, 1, 6, 4, WORLD_2D_ACT.letter);
		buffer.set(3, 2, WORLD_2D_ACT.letterSeal);
		buffer.set(4, 2, WORLD_2D_ACT.letterSeal);
	} else {
		buffer.rect(1, 1, 6, 4, WORLD_2D_ACT.scroll);
		buffer.vline(1, 1, 4, WORLD_2D_ACT.chestBand);
		buffer.vline(6, 1, 4, WORLD_2D_ACT.chestBand);
	}
	buffer.outline(0.55, false, WORLD_2D_ACT.outline);
	return toSprite(buffer, 4, 6);
}

const carries = spriteCache(buildCarry);

/** What an asker carries: a letter (an approval) or a scroll (a question). */
export function carrySprite(kind: "letter" | "scroll"): Sprite {
	return carries(kind, kind);
}

function buildFlag(): Sprite {
	const buffer = new PixelBuffer(8, 12);
	buffer.vline(1, 0, 12, WORLD_2D_ACT.flagPole);
	buffer.rect(2, 1, 5, 4, WORLD_2D_ACT.flag);
	buffer.outline(0.55, false, WORLD_2D_ACT.outline);
	return toSprite(buffer, 1, 12);
}

let flag: Sprite | null = null;

/** An interrupted run's grey flag, anchored at its pole's foot. */
export function flagSprite(): Sprite {
	flag ??= buildFlag();
	return flag;
}

function buildPost(): Sprite {
	const buffer = new PixelBuffer(12, 16);
	buffer.vline(5, 6, 10, WORLD_2D_ACT.post);
	buffer.vline(6, 6, 10, WORLD_2D_ACT.post);
	buffer.rect(1, 0, 10, 7, WORLD_2D_ACT.post);
	buffer.rect(3, 2, 6, 3, WORLD_2D_ACT.letter);
	buffer.set(5, 3, WORLD_2D_ACT.letterSeal);
	buffer.set(6, 3, WORLD_2D_ACT.letterSeal);
	buffer.outline(0.55, false, WORLD_2D_ACT.outline);
	return toSprite(buffer, 6, 16);
}

let post: Sprite | null = null;

/** A notice post with its letter: an ask nobody carries, anchored bottom-centre. */
export function postSprite(): Sprite {
	post ??= buildPost();
	return post;
}

function buildMark(kind: "note" | "unread"): Sprite {
	const buffer = new PixelBuffer(8, 7);
	if (kind === "unread") {
		buffer.rect(1, 1, 6, 5, WORLD_2D_ACT.letter);
		buffer.hline(1, 1, 6, WORLD_2D_ACT.letterSeal);
	} else {
		buffer.rect(1, 1, 6, 5, WORLD_2D_ACT.note);
		buffer.hline(2, 3, 4, WORLD_2D_ACT.ink);
	}
	buffer.outline(0.55, false, WORLD_2D_ACT.outline);
	return toSprite(buffer, 4, 7);
}

const marks = new Map<string, Sprite>();

/** An unread answer's letter or a suggestion's note at a home, bottom-centre. */
export function markSprite(kind: "note" | "unread"): Sprite {
	let sprite = marks.get(kind);
	if (!sprite) {
		sprite = buildMark(kind);
		marks.set(kind, sprite);
	}
	return sprite;
}

function buildLamp(dim: boolean): Sprite {
	const buffer = new PixelBuffer(7, 9);
	buffer.rect(1, 6, 5, 2, WORLD_2D_ACT.alarmBase);
	buffer.ellipse(
		3,
		4,
		2.2,
		2.6,
		dim ? WORLD_2D_ACT.alarmDim : WORLD_2D_ACT.alarm
	);
	if (!dim) {
		buffer.set(2, 3, WORLD_2D_ACT.alarmGlint);
	}
	buffer.outline(0.55, false, WORLD_2D_ACT.outline);
	return toSprite(buffer, 0, 9);
}

const lamps = spriteCache(buildLamp);

/**
 * An alarm lamp, one per counted failure; dim for an old one that no longer
 * counts. Anchored bottom-left.
 */
export function alarmLampSprite(dim: boolean): Sprite {
	return lamps(dim ? "dim" : "lit", dim);
}

function buildFollower(): Sprite {
	const buffer = new PixelBuffer(6, 9);
	buffer.rect(2, 0, 2, 2, WORLD_2D_ACT.followerSkin);
	buffer.rect(1, 2, 4, 4, WORLD_2D_ACT.follower);
	buffer.vline(2, 6, 2, WORLD_2D_ACT.alarmBase);
	buffer.vline(3, 6, 2, WORLD_2D_ACT.alarmBase);
	buffer.outline(0.55, false, WORLD_2D_ACT.outline);
	return toSprite(buffer, 0, 9);
}

let follower: Sprite | null = null;

/** A running helper, following its agent; anchored bottom-left. */
export function followerSprite(): Sprite {
	follower ??= buildFollower();
	return follower;
}

function buildSign(): Sprite {
	const buffer = new PixelBuffer(10, 12);
	buffer.vline(4, 5, 7, WORLD_2D_ACT.post);
	buffer.rect(0, 1, 9, 5, WORLD_2D_ACT.post);
	// An arrow pointing on: what comes next.
	buffer.hline(2, 3, 4, WORLD_2D_ACT.signArrow);
	buffer.set(5, 2, WORLD_2D_ACT.signArrow);
	buffer.set(5, 4, WORLD_2D_ACT.signArrow);
	buffer.set(6, 3, WORLD_2D_ACT.signArrow);
	buffer.outline(0.55, false, WORLD_2D_ACT.outline);
	return toSprite(buffer, 0, 12);
}

let sign: Sprite | null = null;

/** The next step's signpost (its words are in the talk panel), bottom-left. */
export function nextSignSprite(): Sprite {
	sign ??= buildSign();
	return sign;
}

/** The tools a working villager can hold in the 2D village. */
export type World2dTool =
	| "book"
	| "clipboard"
	| "globe"
	| "lens"
	| "quill"
	| "wrench";

function buildTool(tool: World2dTool): Sprite {
	const buffer = new PixelBuffer(8, 8);
	switch (tool) {
		case "book":
			buffer.rect(1, 2, 6, 5, WORLD_2D_ACT.chestBand);
			buffer.rect(2, 3, 4, 3, WORLD_2D_ACT.letter);
			break;
		case "clipboard":
			buffer.rect(1, 1, 6, 6, WORLD_2D_ACT.toolWood);
			buffer.rect(2, 2, 4, 4, WORLD_2D_ACT.letter);
			buffer.hline(3, 1, 2, WORLD_2D_ACT.toolMetal);
			break;
		case "globe":
			buffer.ellipse(3.5, 3.5, 2.6, 2.6, WORLD_2D_ACT.toolGlobe);
			buffer.hline(2, 3, 4, WORLD_2D_ACT.note);
			break;
		case "lens":
			buffer.ellipse(3, 3, 2.2, 2.2, WORLD_2D_ACT.toolMetal);
			buffer.set(3, 3, WORLD_2D_ACT.glass);
			buffer.set(5, 5, WORLD_2D_ACT.toolWood);
			buffer.set(6, 6, WORLD_2D_ACT.toolWood);
			break;
		case "quill":
			buffer.vline(2, 1, 4, WORLD_2D_ACT.letter);
			buffer.vline(3, 1, 5, WORLD_2D_ACT.letter);
			buffer.set(4, 6, WORLD_2D_ACT.ink);
			break;
		default:
			buffer.rect(3, 3, 2, 4, WORLD_2D_ACT.toolWood);
			buffer.rect(2, 1, 4, 2, WORLD_2D_ACT.toolMetal);
			break;
	}
	buffer.outline(0.55, false, WORLD_2D_ACT.outline);
	return toSprite(buffer, 4, 8);
}

const tools = spriteCache(buildTool);

/** The tool in a working villager's hand, anchored bottom-centre. */
export function toolSprite(tool: World2dTool): Sprite {
	return tools(tool, tool);
}
