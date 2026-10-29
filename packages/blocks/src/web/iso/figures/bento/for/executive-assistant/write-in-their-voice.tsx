import {
	boxCorners,
	cylinder,
	lineOnTop,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Write in their voice: an autopen. A stylus traces the grooves of a template
 * disc cut from past letters; the linked arms carry the motion across to a
 * pen whose nib (the lit part) writes the same hand on a fresh sheet.
 */

const PLATE = { x: -100, y: -58, w: 200, d: 116, r: 8 };
const DISC: [number, number] = [-62, -22];
const ARM_Y = -34;
const ARM_Z = 32;
const PEN: [number, number] = [56, 22];
const SHEET = { x: 24, y: -6, w: 64, d: 52, r: 1 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, ARM_Y, ARM_Z + 10],
]);

benchPlate(s, PLATE);
// The fresh sheet, already carrying a few written lines.
s.halo(SHEET, 0);
s.solid(slabOf(SHEET, 0, 1.2, s.P, 2), { crease: "none" });
for (const [i, reach] of [46, 38, 28].entries()) {
	const y = SHEET.y + 10 + i * 7;
	s.line(lineOnTop([SHEET.x + 8, y], [SHEET.x + reach, y], 1.2, s.P), {
		tone: "lo",
	});
}
// Template disc with its grooves, on a turned base.
s.halo({ x: DISC[0] - 24, y: DISC[1] - 24, w: 48, d: 48, r: 24 }, 0);
s.solid(cylinder(DISC[0], DISC[1], 24, 0, 5, s.P, 48, 0.6), { tone: "lo" });
s.solid(cylinder(DISC[0], DISC[1], 21, 5, 5, s.P, 48, 0.6));
for (const radius of [17, 13, 9]) {
	s.line(ring(DISC[0], DISC[1], radius, 10, s.P, 40), { tone: "lo" });
}
s.solid(cylinder(DISC[0], DISC[1], 3, 10, 2, s.P, 20), { tone: "lo" });
// Stylus resting in a groove, hung from the arm.
s.solid(cylinder(DISC[0] + 6, ARM_Y + 3, 1.4, 10, ARM_Z - 10, s.P, 12));
// Pivot tower.
const tower = { x: -28, y: ARM_Y - 6, w: 16, d: 16, r: 2 };
s.halo(tower, 0);
s.solid(slabOf(tower, 0, ARM_Z, s.P, 4, 0.8));
knob(s, [-20, ARM_Y + 18], 0, 4, 5);
// The long arm across the top, then the cross arm down to the pen.
s.solid(
	slabOf({ x: -60, y: ARM_Y, w: 122, d: 6, r: 2 }, ARM_Z, 4, s.P, 3, 0.4)
);
s.solid(cylinder(-20, ARM_Y + 3, 4, ARM_Z + 4, 3, s.P, 24), { tone: "lo" });
s.solid(cylinder(PEN[0], ARM_Y + 3, 4.5, ARM_Z - 6, 13, s.P, 24), {
	tone: "lo",
});
s.solid(
	slabOf(
		{ x: PEN[0] - 3, y: ARM_Y + 6, w: 6, d: PEN[1] - ARM_Y - 6, r: 1.5 },
		ARM_Z - 4,
		4,
		s.P,
		3
	)
);
// Pen: nib on the paper, barrel through the clamp.
s.solid(cylinder(PEN[0], PEN[1], 1.6, 1.2, 3, s.P, 16), { lit: true });
s.solid(cylinder(PEN[0], PEN[1], 3, 4.2, ARM_Z - 9, s.P, 20));
s.solid(cylinder(PEN[0], PEN[1], 5.5, ARM_Z - 5, 6, s.P, 24), { tone: "lo" });
s.solid(cylinder(PEN[0], PEN[1], 2.6, ARM_Z + 1, 5, s.P, 20));
screws(s, [[SHEET.x + SHEET.w + 4, SHEET.y - 6]], 0, 1.4);

export const drawing = cardDrawing(s);
