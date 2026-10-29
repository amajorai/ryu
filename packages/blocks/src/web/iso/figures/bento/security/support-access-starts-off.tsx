import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	radialTicks,
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
 * Support access starts off: a console whose slide switch rests at the off
 * end of its track (the lit slider), beside a timer dial that sets how long
 * access lasts. The log printer next to it tapes out a line for every read.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const CONSOLE = { x: -82, y: -36, w: 86, d: 64, r: 5 };
const CON_H = 18;
const PRINTER = { x: 20, y: -36, w: 52, d: 40, r: 4 };
const PRN_H = 24;
const TAPE = { x: 30, y: PRINTER.y + PRINTER.d, w: 32, d: 38, r: 1 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[PRINTER.x, PRINTER.y, PRN_H + 6],
	...boxCorners(CONSOLE, CON_H, CON_H + 7),
]);

benchPlate(s, PLATE);
// Console: the slide switch track, the slider parked at its back (off) end.
s.halo(CONSOLE, 0);
s.solid(slabOf(CONSOLE, 0, CON_H, s.P, 6, 1));
s.line(planOutline(insetPlan(CONSOLE, 5), CON_H, s.P, 4), { tone: "faint" });
const track = { x: CONSOLE.x + 14, y: CONSOLE.y + 10, w: 8, d: 44, r: 3 };
s.solid(slabOf(track, CON_H, 0.8, s.P, 3), { tone: "lo", crease: "none" });
s.line(
	lineOnTop(
		[track.x + 4, track.y + 4],
		[track.x + 4, track.y + track.d - 4],
		CON_H + 0.8,
		s.P
	),
	{ tone: "faint" }
);
s.solid(
	slabOf(
		{ x: track.x - 3, y: track.y + 1, w: 14, d: 12, r: 2 },
		CON_H,
		7,
		s.P,
		3
	),
	{ lit: true }
);
// Timer dial: ticks around a knob set back to zero.
const dial: [number, number] = [CONSOLE.x + 52, CONSOLE.y + 30];
const ticks = radialTicks(dial[0], dial[1], 18, 24, 6, CON_H, [2, 4], s.P);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
knob(s, dial, CON_H, 10, 6);
lamp(s, [CONSOLE.x + CONSOLE.w - 10, CONSOLE.y + 9], CON_H, { radius: 1.8 });
screws(
	s,
	[
		[CONSOLE.x + 8, CONSOLE.y + CONSOLE.d - 8],
		[CONSOLE.x + CONSOLE.w - 8, CONSOLE.y + CONSOLE.d - 8],
	],
	CON_H,
	1.4
);
// Log printer, with its tape run out across the bench.
s.halo(PRINTER, 0);
s.solid(slabOf(PRINTER, 0, PRN_H, s.P, 6, 0.8));
s.solid(
	slabOf(
		{ x: PRINTER.x + 8, y: PRINTER.y + 6, w: 36, d: 16, r: 6 },
		PRN_H,
		4,
		s.P,
		6,
		0.6
	),
	{ tone: "lo" }
);
const front = PRINTER.y + PRINTER.d;
s.line(faceRect(s, "y", front, TAPE.x - 2, TAPE.x + TAPE.w + 2, 10, 13), {
	tone: "mid",
});
s.solid(slabOf({ ...TAPE, y: front, d: 1 }, 0.8, 10.6, s.P, 2), {
	crease: "none",
});
s.solid(slabOf(TAPE, 0, 0.8, s.P, 2), { crease: "none" });
for (let i = 0; i < 5; i++) {
	const y = TAPE.y + 6 + i * 6.5;
	const width = [24, 18, 22, 14, 20][i] ?? 18;
	s.line(lineOnTop([TAPE.x + 4, y], [TAPE.x + 4 + width, y], 0.8, s.P), {
		tone: i === 4 ? "mid" : "lo",
	});
}

export const drawing = cardDrawing(s);
