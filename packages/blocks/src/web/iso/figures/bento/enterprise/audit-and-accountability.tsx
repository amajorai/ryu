import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Audit and accountability: a stack of record sheets and the stamp that
 * signs them. The top record carries the stamp's mark (the lit seal, who
 * acted), its lines say what happened, and one line is blacked out.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const SHEET = { x: -80, y: -38, w: 78, d: 76, r: 2 };
const SHEETS = 6;
const SHEET_H = 1.6;
const PAD = { x: 20, y: -40, w: 52, d: 34, r: 4 };
const STAMP: [number, number] = [46, 20];
const STAMP_TOP = 40;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[STAMP[0], STAMP[1], STAMP_TOP],
]);

benchPlate(s, PLATE);
// The record stack, each sheet a little askew of the one below.
s.halo(SHEET, 0);
for (let i = 0; i < SHEETS; i++) {
	const shift = i % 2 === 0 ? 0 : 1.2;
	s.solid(
		slabOf(
			{ ...SHEET, x: SHEET.x + shift, y: SHEET.y - shift },
			i * SHEET_H,
			SHEET_H,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
const top = SHEETS * SHEET_H;
const lines = [56, 44, 60, 0, 50, 38];
lines.forEach((length, i) => {
	const y = SHEET.y + 10 + i * 8;
	if (length === 0) {
		s.solid(
			slabOf(
				{ x: SHEET.x + 7, y: y - 2.4, w: 46, d: 4.8, r: 1 },
				top,
				1.2,
				s.P,
				2
			),
			{
				tone: "lo",
				crease: "none",
			}
		);
		return;
	}
	s.line(lineOnTop([SHEET.x + 7, y], [SHEET.x + 7 + length, y], top, s.P), {
		tone: i === 0 ? "mid" : "lo",
	});
});
// The seal the stamp left in the corner.
s.solid(cylinder(SHEET.x + 62, SHEET.y + 60, 8, top, 0.8, s.P, 32), {
	lit: true,
	crease: "none",
});
s.line(ring(SHEET.x + 62, SHEET.y + 60, 5, top + 0.8, s.P, 28), {
	tone: "mid",
});
// Ink pad: a shallow tin with its felt.
s.halo(PAD, 0);
s.solid(slabOf(PAD, 0, 6, s.P, 4, 0.6));
s.solid(slabOf(insetPlan(PAD, 4), 6, 0.8, s.P, 3), {
	tone: "lo",
	crease: "none",
});
s.line(planOutline(insetPlan(PAD, 7), 6.8, s.P, 2), { tone: "faint" });
// The stamp standing on its foot.
const foot = { x: STAMP[0] - 13, y: STAMP[1] - 11, w: 26, d: 22, r: 2 };
s.halo(foot, 0);
s.solid(slabOf(foot, 0, 4, s.P, 3, 0.4), { tone: "lo" });
s.solid(slabOf(insetPlan(foot, 1.5), 4, 6, s.P, 3, 0.6));
s.solid(cylinder(STAMP[0], STAMP[1], 3.5, 10, 16, s.P, 20));
s.solid(cylinder(STAMP[0], STAMP[1], 9, 26, STAMP_TOP - 26, s.P, 36, 1.2));
s.line(knurl(STAMP[0], STAMP[1], 9, 29, STAMP_TOP - 3, 30, s.P), {
	tone: "lo",
});

export const drawing = cardDrawing(s);
