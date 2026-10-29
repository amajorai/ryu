import {
	boxCorners,
	cylinder,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Coverage gap analysis: a grid tray, one cell per branch. Covered branches
 * hold a block; the scanner bridge sweeps across and leaves flag pins in the
 * empty cells, the riskiest one first (the lit flag).
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const TRAY = { x: -80, y: -40, w: 146, d: 82, r: 4 };
const TRAY_H = 8;
const COLS = 7;
const ROWS = 4;
const CELL = 17;
const GAP = 2.4;
const BRIDGE_X = 76;
const EMPTY = new Set(["1,2", "4,1", "5,3", "2,0"]);
const RISKIEST = "4,1";

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-20, -40, 28]]);

const cellPlan = (c: number, r: number) => ({
	x: TRAY.x + 6 + c * (CELL + GAP),
	y: TRAY.y + 4 + r * (CELL + GAP),
	w: CELL,
	d: CELL,
	r: 1.5,
});

benchPlate(s, PLATE);
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 6, 0.8));
const cells: [number, number, number, number][] = [];
for (let c = 0; c < COLS; c++) {
	for (let r = 0; r < ROWS; r++) {
		const plan = cellPlan(c, r);
		cells.push([plan.x + CELL / 2, plan.y + CELL / 2, c, r]);
	}
}
for (const [, , c, r] of byDepth(cells, s, TRAY_H)) {
	const plan = cellPlan(c, r);
	if (EMPTY.has(`${c},${r}`)) {
		s.line(planOutline(plan, TRAY_H, s.P, 2), { tone: "mid" });
		const [x, y] = [plan.x + CELL / 2, plan.y + CELL / 2];
		const lit = `${c},${r}` === RISKIEST;
		s.solid(cylinder(x, y, 1, TRAY_H, 18, s.P, 10));
		s.solid(
			slabOf(
				{ x, y: y - 0.6, w: lit ? 12 : 8, d: 1.2, r: 0.2 },
				TRAY_H + (lit ? 10 : 12),
				lit ? 8 : 6,
				s.P,
				2
			),
			{ lit, tone: lit ? "hi" : "lo", crease: "none" }
		);
	} else {
		s.solid(slabOf(plan, TRAY_H, 6, s.P, 2, 0.4), { tone: "mid" });
	}
}
// The scanner bridge parked on its rails at the right end of the tray.
const rail = { x: BRIDGE_X - 4, y: TRAY.y - 4, w: 8, d: TRAY.d + 8, r: 2 };
s.solid(slabOf({ x: rail.x, y: rail.y, w: 8, d: 8, r: 1 }, 0, 26, s.P, 3, 0.6));
s.solid(slabOf({ ...rail, y: rail.y + rail.d - 8, d: 8 }, 0, 26, s.P, 3, 0.6));
s.solid(slabOf(rail, 26, 6, s.P, 3, 0.6));
lamp(s, [BRIDGE_X, rail.y + rail.d / 2], 32, { radius: 1.8 });

export const drawing = cardDrawing(s);
