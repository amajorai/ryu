import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, knob, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Hide work details: a screen with a privacy shutter. The display bed shows
 * its lines of text on the left; the slatted shutter has been slid across the
 * right half on its rails, so what's under it can't be read, and the knob on
 * the front ledge is what slides it.
 */

const PLATE = { x: -92, y: -52, w: 184, d: 104, r: 8 };
const BED = { x: -70, y: -40, w: 140, d: 66, r: 6 };
const BED_H = 8;
const GLASS = insetPlan(BED, 7);
const SHUTTER = { x: -2, y: BED.y - 2, w: 72, d: BED.d + 4, r: 3 };
const SHUTTER_H = 4;
const SLATS = 9;
const LINES = [-28, -20, -12, -4, 4, 12];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, BED_H + 12]]);

benchPlate(s, PLATE);
s.halo(BED, 0);
s.solid(slabOf(BED, 0, BED_H, s.P, 6, 1));
s.solid(slabOf(GLASS, BED_H, 0.6, s.P, 4), { tone: "lo", crease: "none" });
// The text on the screen, left of the shutter.
for (const [index, y] of LINES.entries()) {
	const end = GLASS.x + 20 + ((index * 23) % 40);
	s.line(
		lineOnTop(
			[GLASS.x + 6, y],
			[Math.min(end, SHUTTER.x - 4), y],
			BED_H + 0.6,
			s.P
		),
		{
			tone: index === 0 ? "hi" : "mid",
		}
	);
}
// Rails along the back and front edge, then the slatted shutter riding them.
for (const y of [BED.y + 2, BED.y + BED.d - 2]) {
	s.line(lineOnTop([GLASS.x, y], [BED.x + BED.w - 2, y], BED_H, s.P), {
		tone: "lo",
	});
}
s.halo(SHUTTER, BED_H);
s.solid(slabOf(SHUTTER, BED_H + 0.6, SHUTTER_H, s.P, 4, 0.6), { lit: true });
const top = BED_H + 0.6 + SHUTTER_H;
for (let index = 1; index < SLATS; index++) {
	const x = SHUTTER.x + (SHUTTER.w * index) / SLATS;
	s.line(
		lineOnTop([x, SHUTTER.y + 2], [x, SHUTTER.y + SHUTTER.d - 2], top, s.P),
		{ tone: "faint" }
	);
}
s.line(planOutline(insetPlan(SHUTTER, 2), top, s.P, 3), { tone: "faint" });
screws(
	s,
	[
		[BED.x + 6, BED.y + 6],
		[BED.x + 6, BED.y + BED.d - 6],
	],
	BED_H,
	1.2
);
knob(s, [-48, BED.y + BED.d + 10], 0, 4.5, 4);

export const drawing = cardDrawing(s);
