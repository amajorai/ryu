import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	radialTicks,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Import a session: a cartridge reader. A fresh session cartridge (the lit
 * part) stands half-seated in the slot; the timer dial counts down its life,
 * and the spent one lies in the return tray, ready to be swapped.
 */

const PLATE = { x: -84, y: -50, w: 176, d: 100, r: 8 };
const READER = { x: -66, y: -36, w: 78, d: 68, r: 5 };
const READER_H = 30;
const DIAL: [number, number] = [-6, 14];
const TRAY = { x: 30, y: -14, w: 46, d: 40, r: 3 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-26, -4, READER_H + 26],
]);

benchPlate(s, PLATE);
// The spent cartridge's return tray, behind the reader's right side.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 5, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf({ x: 38, y: -4, w: 30, d: 18, r: 2 }, 5, 4, s.P, 3));
s.line(lineOnTop([42, 0], [64, 0], 9, s.P), { tone: "lo" });
// The reader.
s.halo(READER, 0);
s.solid(slabOf(READER, 0, READER_H, s.P, 6, 1));
s.line(planOutline(insetPlan(READER, 5), READER_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[READER.x + 9, READER.y + 9],
		[READER.x + READER.w - 9, READER.y + 9],
	],
	READER_H,
	1.6
);
const slot = { x: -50, y: -8, w: 46, d: 7, r: 1.5 };
s.line(planOutline(slot, READER_H, s.P, 2), { tone: "mid" });
// Cartridge half-seated, with a grip lip.
s.solid(
	slabOf({ x: -46, y: -6.5, w: 38, d: 4, r: 0.8 }, READER_H, 20, s.P, 2),
	{
		lit: true,
	}
);
s.solid(
	slabOf({ x: -47, y: -7.5, w: 40, d: 6, r: 1 }, READER_H + 20, 3, s.P, 2),
	{ lit: true }
);
// Countdown dial.
s.solid(cylinder(DIAL[0], DIAL[1], 11, READER_H, 2, s.P, 40), { tone: "lo" });
s.line(ring(DIAL[0], DIAL[1], 9, READER_H + 2, s.P, 40), { tone: "lo" });
const ticks = radialTicks(
	DIAL[0],
	DIAL[1],
	8,
	24,
	6,
	READER_H + 2,
	[1.5, 3],
	s.P
);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
s.line(lineOnTop(DIAL, [DIAL[0] + 5, DIAL[1] - 5], READER_H + 2.4, s.P), {
	tone: "hi",
});
s.solid(cylinder(DIAL[0], DIAL[1], 1.6, READER_H + 2, 1.2, s.P, 16));

export const drawing = cardDrawing(s);
