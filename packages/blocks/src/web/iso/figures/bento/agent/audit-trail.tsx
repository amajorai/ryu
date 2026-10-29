import {
	boxCorners,
	cylinder,
	insetPlan,
	onTop,
	type Point3,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, knob, lamp } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Audit trail: a reel-to-reel recorder. Tape runs off the full reel, past
 * the recording head at the front and onto the take-up reel; the head's
 * record lamp (the lit part) never goes out, so every call lands on tape.
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const DECK = { x: -84, y: -44, w: 168, d: 82, r: 5 };
const DECK_H = 8;
const Z = DECK_H;
const REELS: [Point3, Point3] = [
	[-44, -12, 22],
	[44, -12, 13],
];
const REEL_R = 26;
const PACK_H = 7;
const HEAD = { x: -10, y: 18, w: 20, d: 12, r: 2 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, Z + 14]]);

benchPlate(s, PLATE);
s.halo(DECK, 0);
s.solid(slabOf(DECK, 0, DECK_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(DECK, 4), Z, s.P, 4), { tone: "faint" });
s.line(faceRect(s, "y", DECK.y + DECK.d, 50, 74, 2, 6), { tone: "lo" });
// Reels: a flange, the wound tape pack and a hub with spindle.
for (const [x, y, pack] of REELS) {
	s.solid(cylinder(x, y, REEL_R, Z, 1.4, s.P, 48, 0.4), { tone: "lo" });
	s.solid(cylinder(x, y, pack, Z + 1.4, PACK_H, s.P, 48));
	s.line(ring(x, y, pack - 3, Z + 1.4 + PACK_H, s.P, 40), { tone: "faint" });
	s.solid(cylinder(x, y, 5, Z + 1.4 + PACK_H, 2, s.P, 24), { tone: "lo" });
	s.solid(cylinder(x, y, 2, Z + 3.4 + PACK_H, 3, s.P, 16));
}
// Tape path: off the full reel, round two guides, past the head, onto take-up.
const TAPE_Z = Z + 5;
const [lx, ly, lr] = REELS[0];
const [rx, ry, rr] = REELS[1];
s.line(
	onTop(
		[
			[lx, ly + lr],
			[-24, 22],
			[-10, 18],
			[10, 18],
			[24, 22],
			[rx, ry + rr],
		],
		TAPE_Z,
		s.P
	),
	{ tone: "hi" }
);
for (const gx of [-24, 24]) {
	s.solid(cylinder(gx, 25, 3, Z, 9, s.P, 20));
}
// Recording head with its record lamp.
s.halo(HEAD, Z);
s.solid(slabOf(HEAD, Z, 10, s.P, 3, 0.6));
s.line(planOutline(insetPlan(HEAD, 3), Z + 10, s.P, 2), { tone: "lo" });
lamp(s, [0, 24], Z + 10, { lit: true, radius: 2.4 });
// Transport keys and a level knob along the front.
for (let i = 0; i < 4; i++) {
	s.solid(
		slabOf({ x: -76 + i * 10, y: 24, w: 8, d: 8, r: 1 }, Z, 2.5, s.P, 2, 0.4),
		{ tone: i === 0 ? "lo" : "mid" }
	);
}
knob(s, [62, 26], Z, 4.5, 4);

export const drawing = cardDrawing(s);
