import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";
import { bar } from "./bar.ts";

/*
 * Incident and finding triage: a sorting gate. Reports wait in the intake
 * tray at the back; a diverter gate on a pivot swings toward three severity bins, marked by
 * one, two and three lamps. It is thrown to the highest, where the new
 * record has just been filed (the lit card).
 */

const PLATE = { x: -96, y: -56, w: 192, d: 112, r: 8 };
const INTAKE = { x: -82, y: -46, w: 50, d: 34, r: 3 };
const PIVOT: [number, number] = [-6, -28];
const ARM_Z = 18;
const BIN_Y = 8;
const BIN_D = 34;
const BINS = [-74, -24, 26];
const BIN_W = 44;
const BIN_H = [10, 14, 18];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [48, 25, 34]]);

benchPlate(s, PLATE);
// Intake tray with a short stack of reports.
s.halo(INTAKE, 0);
s.solid(slabOf(INTAKE, 0, 6, s.P, 3, 0.6), { tone: "lo" });
for (let i = 0; i < 3; i++) {
	s.solid(slabOf(insetPlan(INTAKE, 6 + i), 6 + i * 1.6, 1.6, s.P, 2), {
		crease: "none",
	});
}
// The diverter: a pivot post and a gate blade swung toward the third bin.
s.halo({ x: PIVOT[0] - 8, y: PIVOT[1] - 8, w: 16, d: 16, r: 8 }, 0);
s.solid(cylinder(PIVOT[0], PIVOT[1], 7, 0, 3, s.P, 28), { tone: "lo" });
s.solid(cylinder(PIVOT[0], PIVOT[1], 3.6, 3, ARM_Z - 3, s.P, 20));
// A standing gate blade, thrown toward the third bin.
s.solid(bar(PIVOT, [40, -4], 3, 3, ARM_Z - 3, s.P), { tone: "lo" });
s.solid(cylinder(PIVOT[0], PIVOT[1], 4.6, ARM_Z, 4, s.P, 20), { tone: "lo" });
// Severity bins, rising left to right.
BINS.forEach((x, i) => {
	const plan = { x, y: BIN_Y, w: BIN_W, d: BIN_D, r: 3 };
	const h = BIN_H[i]!;
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, h, s.P, 3, 0.8));
	const slot = { x: x + 8, y: BIN_Y + 5, w: BIN_W - 16, d: 8, r: 1.5 };
	s.line(planOutline(slot, h, s.P, 2), { tone: "mid" });
	const cards = [2, 1, 1][i]!;
	for (let c = 0; c < cards; c++) {
		const lit = i === 2;
		s.solid(
			slabOf(
				{
					x: slot.x + 3 + c * 3,
					y: slot.y + 2 + c * 2,
					w: slot.w - 6 - c * 6,
					d: 2,
					r: 0.5,
				},
				h,
				lit ? 12 : 7 - c * 2,
				s.P,
				2
			),
			{ lit, crease: "none" }
		);
	}
	for (let l = 0; l <= i; l++) {
		lamp(s, [x + 10 + l * 7, BIN_Y + 25], h, { radius: 1.6 });
	}
});

export const drawing = cardDrawing(s);
