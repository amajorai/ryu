import {
	boxCorners,
	cylinder,
	lineOnTop,
	radialTicks,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Status digests: a mailbox on a post with a seven-day timer at its foot.
 * Once a week the timer comes round, the progress gathered in the box goes
 * out as a plain-language letter, and the flag (lit) is up: posted.
 */

const PLATE = { x: -90, y: -50, w: 180, d: 100, r: 8 };
const POST = { x: -16, y: -14, w: 12, d: 12, r: 1 };
const BOX = { x: -46, y: -22, w: 72, d: 28, r: 3 };
const BOX_Z = 40;
const BOX_H = 26;
const TIMER: [number, number] = [-56, 28];
const FLAG_X = BOX.x + BOX.w - 18;
const FLAG_Y = BOX.y + BOX.d;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[FLAG_X, FLAG_Y, BOX_Z + BOX_H + 18],
]);

benchPlate(s, PLATE);
// Post on a footing.
s.halo({ x: -24, y: -22, w: 28, d: 28, r: 2 }, 0);
s.solid(slabOf({ x: -24, y: -22, w: 28, d: 28, r: 2 }, 0, 4, s.P, 2, 0.6), {
	tone: "lo",
});
screws(
	s,
	[
		[-20, 2],
		[0, 2],
	],
	4,
	1.1
);
s.solid(slabOf(POST, 4, BOX_Z - 4, s.P, 2, 0.4));
// The box, its door on the +x end with a latch.
s.solid(slabOf(BOX, BOX_Z, BOX_H, s.P, 4, 1));
const end = BOX.x + BOX.w;
s.line(
	faceRect(
		s,
		"x",
		end,
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
	slabOf({ x: end, y: BOX.y + 12, w: 2, d: 4, r: 0.5 }, BOX_Z + 10, 6, s.P, 1)
);
s.line(
	lineOnTop(
		[BOX.x + 8, BOX.y + 14],
		[BOX.x + 40, BOX.y + 14],
		BOX_Z + BOX_H,
		s.P
	),
	{
		tone: "faint",
	}
);
// Flag on the near side, raised.
s.solid(
	slabOf(
		{ x: FLAG_X - 3, y: FLAG_Y, w: 6, d: 2, r: 0.5 },
		BOX_Z + 6,
		6,
		s.P,
		1
	),
	{
		tone: "lo",
	}
);
s.solid(
	slabOf(
		{ x: FLAG_X - 1.5, y: FLAG_Y + 2, w: 3, d: 2, r: 0 },
		BOX_Z + 8,
		BOX_H + 2,
		s.P,
		1
	),
	{
		lit: true,
		crease: "none",
	}
);
s.solid(
	slabOf(
		{ x: FLAG_X - 1.5, y: FLAG_Y + 2, w: 14, d: 2, r: 0 },
		BOX_Z + BOX_H,
		10,
		s.P,
		1
	),
	{
		lit: true,
		crease: "none",
	}
);
// Seven-day timer: a dial with one major tick a day and a pointer.
s.halo({ x: TIMER[0] - 18, y: TIMER[1] - 18, w: 36, d: 36, r: 18 }, 0);
s.solid(cylinder(TIMER[0], TIMER[1], 18, 0, 8, s.P, 48, 0.8));
s.line(ring(TIMER[0], TIMER[1], 15, 8, s.P, 48), { tone: "lo" });
const ticks = radialTicks(TIMER[0], TIMER[1], 14, 28, 4, 8, [2, 4.5], s.P);
s.line(ticks.minor, { tone: "faint" });
s.line(ticks.major, { tone: "mid" });
s.line(lineOnTop(TIMER, [TIMER[0] + 8, TIMER[1] - 6], 10, s.P), { tone: "hi" });
s.solid(cylinder(TIMER[0], TIMER[1], 3.5, 8, 2.6, s.P, 20), { tone: "lo" });
// Outgoing letters stacked on the bench, waiting for the next week.
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf({ x: 34 + i, y: 4 - i, w: 36, d: 24, r: 1 }, i * 2, 2, s.P, 2),
		{
			crease: "none",
		}
	);
}
s.line(lineOnTop([40, 0], [52, 10], 6, s.P), { tone: "lo" });
s.line(lineOnTop([64, 0], [52, 10], 6, s.P), { tone: "lo" });

export const drawing = cardDrawing(s);
