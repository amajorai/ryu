import {
	boxCorners,
	cylinder,
	knurl,
	lineOnTop,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Review a pull request: an inspection loupe on a stand over the change
 * sheet. The lens sweeps the sheet line by line; the spot it caught, a bug
 * or a missed edge case, is marked with a flag pin (the lit part).
 */

const PLATE = { x: -86, y: -50, w: 172, d: 100, r: 8 };
const SHEET = { x: -28, y: -36, w: 92, d: 74, r: 2 };
const POST: [number, number] = [-62, -32];
const ARM_Z = 30;
const LENS: [number, number] = [10, 0];
const LENS_R = 22;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[POST[0], POST[1], ARM_Z + 10],
	[LENS[0], LENS[1] - LENS_R, ARM_Z + 6],
]);

benchPlate(s, PLATE);
// The change sheet: rule lines standing for the diff.
s.halo(SHEET, 0);
s.solid(slabOf(SHEET, 0, 1.4, s.P, 2), { crease: "none" });
for (const [i, width] of [64, 48, 70, 40, 58, 66, 36].entries()) {
	const y = SHEET.y + 10 + i * 10;
	s.line(lineOnTop([SHEET.x + 10, y], [SHEET.x + 10 + width, y], 1.4, s.P), {
		tone: i === 5 ? "hi" : "mid",
	});
}
// Stand: weighted foot, post and a clamp knob.
s.halo({ x: POST[0] - 14, y: POST[1] - 14, w: 28, d: 28, r: 14 }, 0);
s.solid(cylinder(POST[0], POST[1], 14, 0, 6, s.P, 40, 0.8));
screws(s, [[POST[0] + 7, POST[1] + 7]], 6, 1.4);
s.solid(cylinder(POST[0], POST[1], 3.4, 6, ARM_Z + 4 - 6, s.P, 24));
// Arm reaching out to the lens ring.
s.solid(
	slabOf(
		{ x: POST[0] - 5, y: POST[1] - 3, w: 6, d: LENS[1] - POST[1] + 3, r: 1 },
		ARM_Z,
		4,
		s.P,
		2
	)
);
s.solid(
	slabOf(
		{
			x: POST[0] - 5,
			y: LENS[1] - 3,
			w: LENS[0] - POST[0] - LENS_R + 4,
			d: 6,
			r: 1,
		},
		ARM_Z,
		4,
		s.P,
		2
	)
);
s.solid(cylinder(POST[0], POST[1], 5, ARM_Z, 6, s.P, 24), { tone: "lo" });
s.line(knurl(POST[0], POST[1], 5, ARM_Z, ARM_Z + 6, 20, s.P), { tone: "lo" });
// Lens: a rim with a glass disc and a fine inner ring.
s.solid(cylinder(LENS[0], LENS[1], LENS_R, ARM_Z, 4, s.P, 48, 0.6));
s.solid(cylinder(LENS[0], LENS[1], LENS_R - 3, ARM_Z + 4, 0.4, s.P, 48), {
	tone: "lo",
	crease: "none",
});
s.line(ring(LENS[0], LENS[1], LENS_R - 7, ARM_Z + 4.4, s.P, 40), {
	tone: "faint",
});
knob(s, [LENS[0] - LENS_R + 2, LENS[1]], ARM_Z + 4, 2.4, 3);

// The flag pin on the caught line.
const pin: [number, number] = [SHEET.x + 70, SHEET.y + 60];
s.solid(cylinder(pin[0], pin[1], 1.4, 1.4, 20, s.P, 12), { tone: "lo" });
s.solid(
	slabOf({ x: pin[0], y: pin[1] - 1, w: 14, d: 2, r: 0.3 }, 13, 8, s.P, 2),
	{
		lit: true,
		crease: "none",
	}
);

export const drawing = cardDrawing(s);
