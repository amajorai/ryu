import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	type Plane,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Resume a past session: a reel-to-reel tape deck. A thread recorded
 * elsewhere is threaded onto the reels and past the head; pressing play
 * (the lit key) picks the session up exactly where the tape stopped.
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const DECK = { x: -86, y: -44, w: 172, d: 84, r: 5 };
const DECK_H = 16;
const REEL_Y = -16;
const REELS: [Plane, Plane] = [
	[-44, REEL_Y],
	[44, REEL_Y],
];
const HEAD = { x: -9, y: 8, w: 18, d: 8, r: 1.5 };
const TAPE_Z = DECK_H + 5;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-44, REEL_Y, DECK_H + 14],
]);

function reel([x, y]: [number, number], pack: number) {
	s.solid(cylinder(x, y, 5, DECK_H, 2, s.P, 24), { tone: "lo" });
	s.solid(cylinder(x, y, 24, DECK_H + 2, 1.4, s.P, 48));
	s.solid(cylinder(x, y, pack, DECK_H + 3.4, 3.4, s.P, 48), { tone: "lo" });
	s.solid(cylinder(x, y, 24, DECK_H + 6.8, 1.4, s.P, 48));
	s.line(ring(x, y, 16, DECK_H + 8.2, s.P, 40), { tone: "faint" });
	s.solid(cylinder(x, y, 4, DECK_H + 8.2, 4, s.P, 24), { tone: "lo" });
}

function tapeFrom(
	[x, y]: [number, number],
	pack: number,
	to: [number, number]
) {
	const dx = to[0] - x;
	const dy = to[1] - y;
	const length = Math.hypot(dx, dy);
	const start: [number, number] = [
		x + (dx / length) * pack,
		y + (dy / length) * pack,
	];
	s.line(lineOnTop(start, to, TAPE_Z, s.P), { tone: "mid" });
}

benchPlate(s, PLATE);
s.halo(DECK, 0);
s.solid(slabOf(DECK, 0, DECK_H, s.P, 8, 1.2));
s.line(planOutline(insetPlan(DECK, 5), DECK_H, s.P, 6), { tone: "faint" });
screws(
	s,
	[
		[DECK.x + 9, DECK.y + 9],
		[DECK.x + DECK.w - 9, DECK.y + 9],
	],
	DECK_H,
	1.6
);
reel(REELS[0], 20);
// Tape head with guide posts, the tape running past its front.
s.solid(slabOf(HEAD, DECK_H, 8, s.P, 2, 0.4), { tone: "lo" });
for (const x of [HEAD.x - 4, HEAD.x + HEAD.w + 4]) {
	s.solid(cylinder(x, HEAD.y + HEAD.d + 2, 1.6, DECK_H, 8, s.P, 16));
}
tapeFrom(REELS[0], 20, [HEAD.x - 4, HEAD.y + HEAD.d + 2]);
s.line(
	lineOnTop(
		[HEAD.x - 4, HEAD.y + HEAD.d + 2],
		[HEAD.x + HEAD.w + 4, HEAD.y + HEAD.d + 2],
		TAPE_Z,
		s.P
	),
	{ tone: "mid" }
);
tapeFrom(REELS[1], 11, [HEAD.x + HEAD.w + 4, HEAD.y + HEAD.d + 2]);
reel(REELS[1], 11);
// Transport keys along the front edge, play pressed and lit.
const KEY_Y = DECK.y + DECK.d - 18;
[-64, -50, -36, -22].forEach((x, i) => {
	const play = i === 2;
	s.solid(
		slabOf(
			{ x, y: KEY_Y, w: 11, d: 11, r: 1.5 },
			DECK_H,
			play ? 2 : 4,
			s.P,
			3,
			0.4
		),
		{
			lit: play,
		}
	);
});
lamp(s, [30, KEY_Y + 5], DECK_H, { radius: 1.8 });
knob(s, [52, KEY_Y + 5], DECK_H, 5, 5);
knob(s, [70, KEY_Y + 5], DECK_H, 5, 5);

export const drawing = cardDrawing(s);
