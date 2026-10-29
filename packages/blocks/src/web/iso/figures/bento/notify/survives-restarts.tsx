import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, byDepth, knob, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Survives restarts: a reel-to-reel recorder with its own battery pack. Events
 * are wound onto the reels and the full reel still holds every pending one;
 * when the mains drop, the battery cell (the lit part) keeps the deck alive.
 */

const PLATE = { x: -100, y: -52, w: 200, d: 104, r: 8 };
const DECK = { x: -88, y: -40, w: 130, d: 76, r: 5 };
const DECK_H = 12;
const PACK = { x: 52, y: -30, w: 34, d: 56, r: 4 };
const PACK_H = 8;
const CELL_H = 26;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[70, 0, PACK_H + CELL_H + 4],
]);

function reel(x: number, y: number, pack: number) {
	s.solid(cylinder(x, y, 24, DECK_H, 2, s.P, 48, 0.4), { tone: "lo" });
	s.solid(cylinder(x, y, pack, DECK_H + 2, 6, s.P, 48));
	s.line(ring(x, y, pack - 3, DECK_H + 8, s.P, 40), { tone: "faint" });
	s.solid(cylinder(x, y, 6, DECK_H + 8, 3, s.P, 24), { tone: "lo" });
	s.line(ring(x, y, 2, DECK_H + 11, s.P, 12), { tone: "mid" });
}

benchPlate(s, PLATE);
s.halo(DECK, 0);
s.solid(slabOf(DECK, 0, DECK_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(DECK, 4), DECK_H, s.P, 4), { tone: "faint" });
reel(-56, -10, 20);
reel(4, -10, 12);
// Tape runs off both packs to the head at the front.
const TAPE_Z = DECK_H + 5;
s.line(lineOnTop([-56, 10], [-26, 16], TAPE_Z, s.P), { tone: "mid" });
s.line(lineOnTop([-14, 16], [4, 2], TAPE_Z, s.P), { tone: "mid" });
s.solid(
	slabOf({ x: -28, y: 16, w: 16, d: 8, r: 1.5 }, DECK_H, 9, s.P, 3, 0.4),
	{ tone: "lo" }
);
knob(s, [26, 24], DECK_H, 4, 4);
lamp(s, [-76, 26], DECK_H, { radius: 1.8 });
screws(
	s,
	[
		[DECK.x + 6, DECK.y + 6],
		[DECK.x + DECK.w - 6, DECK.y + 6],
	],
	DECK_H,
	1.4
);
// Battery pack: a cradle with two upright cells, wired to the deck.
s.halo(PACK, 0);
s.solid(slabOf(PACK, 0, PACK_H, s.P, 5, 0.6));
const cells: [number, number, boolean][] = [
	[69, -14, false],
	[69, 10, true],
];
for (const [x, y, lit] of byDepth(cells, s, PACK_H)) {
	s.solid(cylinder(x, y, 9, PACK_H, CELL_H, s.P, 32, 0.6), { lit });
	s.solid(cylinder(x, y, 3.5, PACK_H + CELL_H, 2.5, s.P, 20), { tone: "lo" });
}

export const drawing = cardDrawing(s);
