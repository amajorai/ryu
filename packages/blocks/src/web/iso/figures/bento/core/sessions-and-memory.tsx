import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	knob,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Sessions and memory: a reel-to-reel recorder. The conversation winds from
 * one reel to the other past the recording head (the lit lamp); the long-term
 * reel is kept, and a key switch on the deck locks it.
 */

const PLATE = { x: -96, y: -58, w: 192, d: 116, r: 8 };
const DECK = { x: -80, y: -44, w: 160, d: 82, r: 6 };
const DECK_H = 14;
const REEL_R = 24;
const LEFT: [number, number] = [-40, -12];
const RIGHT: [number, number] = [36, -12];
const HEAD = { x: -10, y: 18, w: 20, d: 10, r: 2 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, 26]]);

function reel([x, y]: [number, number], wound: number) {
	const z = DECK_H;
	s.solid(cylinder(x, y, 5, z, 2, s.P, 24), { tone: "lo" });
	s.solid(cylinder(x, y, REEL_R, z + 2, 1.4, s.P, 56, 0.4));
	s.solid(cylinder(x, y, wound, z + 3.4, 4, s.P, 48), { tone: "lo" });
	s.solid(cylinder(x, y, REEL_R, z + 7.4, 1.4, s.P, 56, 0.4));
	s.line(ring(x, y, REEL_R - 6, z + 8.8, s.P, 48), { tone: "faint" });
	s.solid(cylinder(x, y, 4, z + 8.8, 3, s.P, 6), { tone: "lo" });
}

benchPlate(s, PLATE);
s.halo(DECK, 0);
s.solid(slabOf(DECK, 0, DECK_H, s.P, 6, 1));
s.line(planOutline(insetPlan(DECK, 5), DECK_H, s.P, 4), { tone: "faint" });
reel(LEFT, 12);
reel(RIGHT, 20);
// Tape path: off each reel, round the guide posts, across the head.
s.line(
	lineOnTop(
		[LEFT[0] + 12.7, LEFT[1] + 20.4],
		[HEAD.x - 10, HEAD.y + 2],
		DECK_H + 5,
		s.P
	),
	{ tone: "mid" }
);
s.line(
	lineOnTop(
		[RIGHT[0] - 4.3, RIGHT[1] + 23.6],
		[HEAD.x + HEAD.w + 10, HEAD.y + 2],
		DECK_H + 5,
		s.P
	),
	{ tone: "mid" }
);
s.solid(cylinder(HEAD.x - 10, HEAD.y + 2, 2.4, DECK_H, 8, s.P, 20));
s.solid(cylinder(HEAD.x + HEAD.w + 10, HEAD.y + 2, 2.4, DECK_H, 8, s.P, 20));
s.line(
	lineOnTop(
		[HEAD.x - 10, HEAD.y + 2],
		[HEAD.x + HEAD.w + 10, HEAD.y + 2],
		DECK_H + 5,
		s.P
	),
	{ tone: "mid" }
);
s.halo(HEAD, DECK_H);
s.solid(slabOf(HEAD, DECK_H, 8, s.P, 3, 0.4), { tone: "lo" });
lamp(s, [0, HEAD.y + 5], DECK_H + 8, { lit: true, radius: 2 });
// Controls along the front edge: transport keys, a level knob, the key switch.
for (let i = 0; i < 4; i++) {
	s.solid(
		slabOf({ x: -70 + i * 11, y: 26, w: 9, d: 8, r: 1 }, DECK_H, 2, s.P, 2),
		{ tone: "lo" }
	);
}
knob(s, [48, 28], DECK_H, 4.5, 4);
s.solid(cylinder(66, 28, 4.5, DECK_H, 1, s.P, 24), { tone: "lo" });
s.line(lineOnTop([64, 28], [68, 28], DECK_H + 1, s.P), { tone: "hi" });
s.line(faceRect(s, "y", DECK.y + DECK.d, -60, 60, 4, 9), { tone: "faint" });
screws(
	s,
	[
		[DECK.x + 8, DECK.y + 8],
		[DECK.x + DECK.w - 8, DECK.y + 8],
	],
	DECK_H,
	1.5
);

export const drawing = cardDrawing(s);
