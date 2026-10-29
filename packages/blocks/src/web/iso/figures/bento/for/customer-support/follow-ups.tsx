import {
	boxCorners,
	cylinder,
	radialTicks,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Follow-ups: a mailbox on a post with a wind-up timer at its foot. When a
 * ticket goes quiet the timer runs out and a follow-up letter waits in the
 * box with the flag raised (lit) for your team to send.
 */

const PLATE = { x: -60, y: -36, w: 136, d: 88, r: 8 };
const BOX = { x: -46, y: -22, w: 80, d: 30, r: 5 };
const BOX_Z = 36;
const BOX_H = 26;
const FACE = BOX.y + BOX.d;
const DOOR = BOX.x + BOX.w;
const TIMER: [number, number] = [50, 26];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-20, FACE, BOX_Z + BOX_H + 26],
]);

benchPlate(s, PLATE);
// Footing and post.
const footing = { x: -24, y: -20, w: 28, d: 26, r: 3 };
s.halo(footing, 0);
s.solid(slabOf(footing, 0, 6, s.P, 4, 0.8), { tone: "lo" });
screws(
	s,
	[
		[footing.x + 4, footing.y + footing.d - 4],
		[footing.x + footing.w - 4, footing.y + footing.d - 4],
	],
	6,
	1
);
s.solid(slabOf({ x: -16, y: -13, w: 12, d: 12, r: 1 }, 6, BOX_Z - 6, s.P, 2));
// The box, with its door on the near end and the letter in it.
s.solid(slabOf(BOX, BOX_Z, BOX_H, s.P, 4, 1.2));
s.line(
	faceRect(
		s,
		"x",
		DOOR,
		BOX.y + 4,
		BOX.y + BOX.d - 4,
		BOX_Z + 4,
		BOX_Z + BOX_H - 4
	),
	{
		tone: "lo",
	}
);
s.solid(
	slabOf({ x: DOOR, y: BOX.y + 12, w: 3, d: 6, r: 1 }, BOX_Z + 14, 3, s.P, 2)
);
s.solid(
	slabOf(
		{ x: BOX.x + 30, y: BOX.y + 8, w: 28, d: 3, r: 0 },
		BOX_Z + BOX_H,
		10,
		s.P,
		1
	)
);
// The flag, pivoted on the near face and raised.
s.solid(cylinder(BOX.x + 14, FACE + 2, 3, BOX_Z + 8, 2, s.P, 20), {
	tone: "lo",
});
s.solid(
	slabOf({ x: BOX.x + 12, y: FACE, w: 4, d: 2, r: 0 }, BOX_Z + 9, 40, s.P, 1)
);
s.solid(
	slabOf({ x: BOX.x + 16, y: FACE, w: 16, d: 2, r: 0 }, BOX_Z + 37, 12, s.P, 1),
	{
		lit: true,
	}
);
// Wind-up timer at the front.
s.halo({ x: TIMER[0] - 16, y: TIMER[1] - 16, w: 32, d: 32, r: 16 }, 0);
s.solid(cylinder(TIMER[0], TIMER[1], 16, 0, 10, s.P, 48, 0.8));
s.line(ring(TIMER[0], TIMER[1], 13, 10, s.P, 48), { tone: "lo" });
const ticks = radialTicks(TIMER[0], TIMER[1], 12, 24, 6, 10, [2, 4], s.P);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
knob(s, TIMER, 10, 4, 4);

export const drawing = cardDrawing(s);
