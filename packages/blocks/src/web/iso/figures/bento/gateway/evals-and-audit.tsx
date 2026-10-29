import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, faceRules, knob } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Evals and audit: replies pass a scoring station (a dial set to the grade),
 * then end in the audit drawer at the front, always the last stop. Its drawer
 * is open on the newest record card (the lit part).
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const STATION = { x: -82, y: -34, w: 52, d: 40, r: 4 };
const CABINET = { x: 10, y: -30, w: 62, d: 56, r: 4 };
const CAB_H = 34;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [40, 0, CAB_H + 4]]);

benchPlate(s, PLATE);
// Scoring station: a low console with a grading dial and three rule lines.
s.halo(STATION, 0);
s.solid(slabOf(STATION, 0, 14, s.P, 6, 0.8));
s.line(planOutline(insetPlan(STATION, 5), 14, s.P, 4), { tone: "faint" });
knob(s, [STATION.x + 16, STATION.y + 20], 14, 7, 5);
faceRules(s, "y", STATION.y + STATION.d, STATION.x + 8, 10, [30, 22], 4);
// Audit cabinet, front drawer pulled out.
s.halo(CABINET, 0);
s.solid(slabOf(CABINET, 0, CAB_H, s.P, 6, 0.8));
const front = CABINET.y + CABINET.d;
s.line(
	faceRect(s, "y", front, CABINET.x + 6, CABINET.x + CABINET.w - 6, 20, 30),
	{
		tone: "lo",
	}
);
const drawer = {
	x: CABINET.x + 6,
	y: front - 6,
	w: CABINET.w - 12,
	d: 22,
	r: 2,
};
s.solid(slabOf(drawer, 4, 13, s.P, 3, 0.6));
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf(
			{
				x: drawer.x + 6,
				y: drawer.y + 4 + i * 5,
				w: drawer.w - 12,
				d: 2,
				r: 0.5,
			},
			17,
			6 + i,
			s.P,
			2
		),
		{ lit: i === 2, crease: "none" }
	);
}

export const drawing = cardDrawing(s);
