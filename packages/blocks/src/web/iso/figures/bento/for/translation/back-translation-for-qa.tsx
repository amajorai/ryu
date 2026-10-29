import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	segment,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Back-translation for QA: a two-pan balance. The source page sits on one
 * pan, the text translated back on the other; the pointer (the lit part)
 * stands at centre on its scale when the meaning weighs the same.
 */

const PLATE = { x: -84, y: -42, w: 168, d: 84, r: 8 };
const BASE = { x: -34, y: -22, w: 68, d: 44, r: 5 };
const BASE_H = 16;
const PAN_X = 50;
const PAN_R = 20;
const PAN_Z = 50;
const BEAM_Z = 36;
const BEAM_H = 6;
const DIAL = { x: -15, y: -22, w: 30, d: 6, r: 1.5 };
const DIAL_H = 34;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, -22, BASE_H + DIAL_H],
	[-PAN_X, 0, PAN_Z + 6],
	[PAN_X, 0, PAN_Z + 6],
]);

function pan(x: number, widths: number[]) {
	const postZ = BEAM_Z + BEAM_H;
	s.solid(cylinder(x, 0, 5, postZ, 2, s.P, 20), { tone: "lo" });
	s.solid(cylinder(x, 0, 3.2, postZ + 2, PAN_Z - postZ - 2, s.P, 20));
	s.solid(cylinder(x, 0, PAN_R, PAN_Z, 3, s.P, 48, 0.6));
	s.line(ring(x, 0, PAN_R - 3, PAN_Z + 3, s.P, 48), { tone: "lo" });
	const page = { x: x - 13, y: -15, w: 26, d: 30, r: 1 };
	s.solid(slabOf(page, PAN_Z + 3, 1.2, s.P, 2), { crease: "none" });
	widths.forEach((width, index) => {
		const y = page.y + 6 + index * 6;
		s.line(
			lineOnTop([page.x + 4, y], [page.x + 4 + width, y], PAN_Z + 4.2, s.P),
			{ tone: index === 0 ? "mid" : "lo" }
		);
	});
}

benchPlate(s, PLATE);
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BASE, 5), BASE_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[BASE.x + 8, BASE.y + 8],
		[BASE.x + BASE.w - 8, BASE.y + BASE.d - 8],
	],
	BASE_H,
	1.4
);
// The scale plate with the pointer at centre.
s.solid(slabOf(DIAL, BASE_H, DIAL_H, s.P, 2, 0.4));
const face = DIAL.y + DIAL.d;
const top = BASE_H + DIAL_H - 4;
for (let i = -3; i <= 3; i++) {
	const length = i === 0 ? 6 : 4;
	s.line(segment([i * 4, face, top], [i * 4, face, top - length], s.P), {
		tone: i === 0 ? "mid" : "lo",
		free: true,
	});
}
s.solid(
	slabOf(
		{ x: -1.6, y: face, w: 3.2, d: 1.6, r: 0.4 },
		BASE_H + 3,
		DIAL_H - 10,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
// Centre pillar and the beam it pivots, carrying a pan post at each end.
s.solid(cylinder(0, 0, 8, BASE_H, 2, s.P, 28), { tone: "lo" });
s.solid(cylinder(0, 0, 5, BASE_H + 2, BEAM_Z - BASE_H - 2, s.P, 24));
s.solid(
	slabOf(
		{ x: -PAN_X - 6, y: -3.5, w: PAN_X * 2 + 12, d: 7, r: 2 },
		BEAM_Z,
		BEAM_H,
		s.P,
		2,
		0.4
	)
);
knob(s, [12, BASE.y + BASE.d - 9], BASE_H, 4, 4);
pan(-PAN_X, [18, 14, 16, 10]);
pan(PAN_X, [18, 14, 16, 10]);

export const drawing = cardDrawing(s);
