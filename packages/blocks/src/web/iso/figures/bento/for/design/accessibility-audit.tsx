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
import { benchPlate, knob, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Accessibility audit: a contrast tester. A two-tone swatch of the screen
 * sits under the sensor head on its stand; the meter beside it reads the
 * ratio against the WCAG mark, and the pass lamp (the lit part) says it holds.
 */

const PLATE = { x: -92, y: -54, w: 184, d: 108, r: 8 };
const POST: [number, number] = [-44, -32];
const HEAD: [number, number] = [-44, -2];
const ARM_Z = 40;
const METER = { x: 12, y: -34, w: 60, d: 50, r: 5 };
const METER_H = 18;
const DIAL: [number, number] = [36, -12];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[POST[0], POST[1], ARM_Z + 12],
]);

benchPlate(s, PLATE);
// Stand: base, column, and the arm out over the swatch.
s.halo({ x: POST[0] - 14, y: POST[1] - 14, w: 28, d: 28, r: 14 }, 0);
s.solid(cylinder(POST[0], POST[1], 13, 0, 4, s.P, 36, 0.6), { tone: "lo" });
s.solid(cylinder(POST[0], POST[1], 4.5, 4, ARM_Z + 6, s.P, 24));
// Swatch card: a dark half beside a light half.
const swatch = { x: -74, y: -14, w: 60, d: 46, r: 2 };
s.halo(swatch, 0);
s.solid(slabOf(swatch, 0, 2, s.P, 3), { crease: "none" });
s.solid(
	slabOf(
		{ x: swatch.x + 4, y: swatch.y + 4, w: 26, d: swatch.d - 8, r: 1 },
		2,
		0.8,
		s.P,
		2
	),
	{ tone: "lo", crease: "none" }
);
// Hatching marks the dark half so it reads in both themes.
for (let hx = swatch.x + 8; hx < swatch.x + 30; hx += 4) {
	s.line(
		lineOnTop([hx, swatch.y + 7], [hx, swatch.y + swatch.d - 7], 2.8, s.P),
		{
			tone: "mid",
		}
	);
}
// Sensor head hanging off the arm, its lens just above the swatch.
s.solid(cylinder(HEAD[0], HEAD[1], 6, 9, 5, s.P, 28), { tone: "lo" });
s.solid(cylinder(HEAD[0], HEAD[1], 9, 14, 10, s.P, 32, 0.6));
s.solid(cylinder(HEAD[0], HEAD[1], 2.5, 24, ARM_Z - 24, s.P, 16), {
	tone: "lo",
});
s.solid(
	slabOf(
		{ x: POST[0] - 5, y: POST[1] - 4, w: 10, d: 40, r: 3 },
		ARM_Z,
		6,
		s.P,
		3
	)
);
s.solid(cylinder(POST[0], POST[1], 6, ARM_Z + 6, 3, s.P, 24), { tone: "lo" });
s.line(ring(HEAD[0], HEAD[1], 2.5, ARM_Z + 6, s.P, 16), { tone: "lo" });
// Meter: a dial reading the ratio, a WCAG stop, and the pass lamp.
s.halo(METER, 0);
s.solid(slabOf(METER, 0, METER_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(METER, 4), METER_H, s.P, 4), { tone: "faint" });
const span = Math.PI * 1.1;
const from = -span / 2;
const ticks = radialTicks(
	DIAL[0],
	DIAL[1],
	16,
	20,
	5,
	METER_H,
	[2, 4],
	s.P,
	from,
	span
);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
const mark = from + span * 0.6;
const reading = from + span * 0.8;
s.line(
	lineOnTop(
		[DIAL[0] + Math.sin(mark) * 17, DIAL[1] - Math.cos(mark) * 17],
		[DIAL[0] + Math.sin(mark) * 11, DIAL[1] - Math.cos(mark) * 11],
		METER_H,
		s.P
	),
	{ tone: "hi" }
);
s.line(
	lineOnTop(
		DIAL,
		[DIAL[0] + Math.sin(reading) * 14, DIAL[1] - Math.cos(reading) * 14],
		METER_H,
		s.P
	),
	{ tone: "hi" }
);
s.solid(cylinder(DIAL[0], DIAL[1], 2.5, METER_H, 2, s.P, 16), { tone: "lo" });
knob(s, [METER.x + 10, METER.y + METER.d - 10], METER_H, 4, 4);
lamp(s, [METER.x + METER.w - 12, METER.y + METER.d - 10], METER_H, {
	lit: true,
	radius: 2.6,
});
lamp(s, [METER.x + METER.w - 22, METER.y + METER.d - 10], METER_H, {
	radius: 2.6,
});
screws(s, [[METER.x + METER.w - 8, METER.y + 8]], METER_H, 1.4);

export const drawing = cardDrawing(s);
