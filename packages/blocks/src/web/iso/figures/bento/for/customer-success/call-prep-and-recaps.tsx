import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Call prep and recaps: a reel-to-reel recorder. The full reel holds the
 * account's history to play back before the call; the take-up reel winds the
 * call into the recap. The record key, pressed down, is the lit part.
 */

const PLATE = { x: -100, y: -56, w: 200, d: 112, r: 8 };
const DECK = { x: -84, y: -44, w: 168, d: 84, r: 6 };
const DECK_H = 16;
const REEL_Y = -14;
const REELS: [number, number][] = [
	[-42, 23],
	[42, 12],
];
const KEYS_Y = DECK.y + DECK.d - 18;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, DECK_H + 8]]);

function reel(x: number, wound: number) {
	const z = DECK_H + 1;
	s.solid(cylinder(x, REEL_Y, 3, DECK_H, 1, s.P, 20), { tone: "lo" });
	s.solid(cylinder(x, REEL_Y, 27, z, 1.2, s.P, 48, 0.4));
	s.line(ring(x, REEL_Y, 24, z + 1.2, s.P, 48), { tone: "faint" });
	s.solid(cylinder(x, REEL_Y, wound, z + 1.2, 3, s.P, 48), { tone: "lo" });
	s.line(ring(x, REEL_Y, 8, z + 4.2, s.P, 32), { tone: "mid" });
	s.solid(cylinder(x, REEL_Y, 4, z + 4.2, 3, s.P, 20));
	s.line(knurl(x, REEL_Y, 4, z + 4.6, z + 7.2, 12, s.P), { tone: "lo" });
}

benchPlate(s, PLATE);
s.halo(DECK, 0);
s.solid(slabOf(DECK, 0, DECK_H, s.P, 6, 1.2));
s.line(planOutline(insetPlan(DECK, 4), DECK_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[DECK.x + 8, DECK.y + 8],
		[DECK.x + DECK.w - 8, DECK.y + 8],
	],
	DECK_H,
	1.4
);
// Tape path between the reels, through the head block.
const head = { x: -10, y: REEL_Y + 18, w: 20, d: 8, r: 1.5 };
s.line(
	lineOnTop([-42 - 18, REEL_Y + 19], [42 + 14, REEL_Y + 16], DECK_H + 3, s.P),
	{ tone: "mid" }
);
for (const [x, radius] of REELS) {
	reel(x, radius);
}
s.solid(slabOf(head, DECK_H, 6, s.P, 2), { tone: "lo" });
// Piano keys along the front; the record key is pressed and lit.
for (let i = 0; i < 5; i++) {
	const record = i === 4;
	s.solid(
		slabOf(
			{ x: -50 + i * 16, y: KEYS_Y, w: 13, d: 12, r: 1 },
			DECK_H,
			record ? 1 : 3,
			s.P,
			2,
			0.4
		),
		{ lit: record }
	);
}
s.line(faceRect(s, "y", DECK.y + DECK.d, 42, 72, 5, 10), { tone: "lo" });

export const drawing = cardDrawing(s);
