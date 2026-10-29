import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	radialTicks,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	knob,
	lamp,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Automated readouts: a timed report printer. The clock dial on top sets the
 * schedule; when it comes round, the printer feeds out a readout sheet (the
 * lit part) with the results ruled on it, ready to read on the bench.
 */

const PLATE = { x: -74, y: -56, w: 142, d: 112, r: 8 };
const BOX = { x: -62, y: -46, w: 78, d: 50, r: 5 };
const BOX_H = 30;
const FRONT = BOX.y + BOX.d;
const CLOCK: [number, number] = [-38, -22];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-20, -30, BOX_H + 8],
]);

benchPlate(s, PLATE);
// Printer body.
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 8, 1));
s.line(planOutline(insetPlan(BOX, 4), BOX_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[BOX.x + 7, BOX.y + 7],
		[BOX.x + BOX.w - 7, BOX.y + BOX.d - 7],
	],
	BOX_H,
	1.4
);
// Clock dial on the top face: when the readout runs.
s.solid(cylinder(CLOCK[0], CLOCK[1], 15, BOX_H, 2, s.P, 48), { tone: "lo" });
const ticks = radialTicks(
	CLOCK[0],
	CLOCK[1],
	13,
	12,
	3,
	BOX_H + 2,
	[2, 4],
	s.P
);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
s.line(lineOnTop(CLOCK, [CLOCK[0] + 7, CLOCK[1] - 5], BOX_H + 2, s.P), {
	tone: "hi",
});
s.solid(cylinder(CLOCK[0], CLOCK[1], 1.8, BOX_H + 2, 1.4, s.P, 16));
knob(s, [-4, -30], BOX_H, 4, 4);
lamp(s, [6, -14], BOX_H, { radius: 2 });
// Paper roll standing beside the printer's right side, nearer
// the viewer than the body, so it is drawn after it.
s.halo({ x: 26, y: -46, w: 28, d: 28, r: 14 }, 0);
s.solid(cylinder(40, -32, 14, 0, 24, s.P, 40, 0.6));
s.line(ring(40, -32, 5, 24, s.P, 24), { tone: "lo" });
s.solid(cylinder(40, -32, 3, 24, 3, s.P, 16), { tone: "lo" });
// The feed slot on the front face and the sheet coming out of it.
s.line(faceRect(s, "y", FRONT, BOX.x + 10, BOX.x + 56, 4, 7), { tone: "lo" });
const sheet = { x: BOX.x + 12, y: FRONT, w: 42, d: 44, r: 1 };
s.solid(slabOf(sheet, 0, 1, s.P, 2), { lit: true });
for (const [index, width] of [30, 22, 26, 14].entries()) {
	const y = FRONT + 8 + index * 6;
	s.line(lineOnTop([sheet.x + 5, y], [sheet.x + 5 + width, y], 1, s.P), {
		tone: index === 0 ? "mid" : "lo",
	});
}
s.line(
	lineOnTop([sheet.x + 5, FRONT + 36], [sheet.x + 14, FRONT + 36], 1, s.P),
	{ tone: "mid" }
);

export const drawing = cardDrawing(s);
