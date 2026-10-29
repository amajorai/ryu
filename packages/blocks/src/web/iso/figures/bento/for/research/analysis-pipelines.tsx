import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Analysis pipelines: a small process line. Data is loaded into the hopper
 * tank, piped through a valve into the processing unit that runs the tools,
 * then up the outlet standpipe and out of the spout into the collecting dish,
 * where the summary lands (the lit puck).
 */

const PLATE = { x: -104, y: -46, w: 208, d: 92, r: 8 };
const TANK: [number, number] = [-70, -10];
const TANK_R = 20;
const TANK_H = 50;
const UNIT = { x: -24, y: -26, w: 52, d: 44, r: 4 };
const UNIT_H = 30;
const VALVE_X = -40;
const STAND: [number, number] = [44, 6];
const STAND_H = 34;
const DISH: [number, number] = [72, 12];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[TANK[0], TANK[1], TANK_H + 10],
	[STAND[0], STAND[1], STAND_H + 6],
]);

function pipe(x0: number, x1: number, y: number) {
	s.solid(
		slabOf({ x: x0, y: y - 5, w: x1 - x0, d: 10, r: 4 }, 0, 10, s.P, 4, 0.4)
	);
}

benchPlate(s, PLATE);
// Hopper tank on a foot ring, banded, with a knurled fill cap.
s.halo(
	{
		x: TANK[0] - TANK_R,
		y: TANK[1] - TANK_R,
		w: 2 * TANK_R,
		d: 2 * TANK_R,
		r: TANK_R,
	},
	0
);
s.solid(cylinder(TANK[0], TANK[1], TANK_R + 3, 0, 4, s.P, 40, 0.6), {
	tone: "lo",
});
s.solid(cylinder(TANK[0], TANK[1], TANK_R, 4, TANK_H - 4, s.P, 48, 0.8));
s.line(ring(TANK[0], TANK[1], TANK_R - 5, TANK_H, s.P, 40), { tone: "faint" });
s.solid(cylinder(TANK[0], TANK[1], 7, TANK_H, 5, s.P, 28), { tone: "lo" });
s.line(knurl(TANK[0], TANK[1], 7, TANK_H, TANK_H + 5, 24, s.P), {
	tone: "lo",
});
// Feed pipe from the tank to the unit, with a valve stem and hand wheel.
pipe(TANK[0] + TANK_R - 4, UNIT.x + 2, -4);
s.solid(cylinder(VALVE_X, -4, 6, 0, 13, s.P, 24), { tone: "lo" });
s.solid(cylinder(VALVE_X, -4, 2.5, 13, 8, s.P, 20));
s.solid(cylinder(VALVE_X, -4, 10, 21, 3, s.P, 36, 0.4), { tone: "lo" });
s.line(ring(VALVE_X, -4, 5, 24, s.P, 24), { tone: "mid" });
// The processing unit: two tool dials, a run lamp, corner screws.
s.halo(UNIT, 0);
s.solid(slabOf(UNIT, 0, UNIT_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(UNIT, 5), UNIT_H, s.P, 4), { tone: "faint" });
knob(s, [UNIT.x + 14, UNIT.y + 14], UNIT_H, 5.5, 6);
knob(s, [UNIT.x + 34, UNIT.y + 14], UNIT_H, 5.5, 6);
lamp(s, [UNIT.x + 42, UNIT.y + 34], UNIT_H, { radius: 2.2 });
screws(
	s,
	[
		[UNIT.x + 6, UNIT.y + UNIT.d - 6],
		[UNIT.x + UNIT.w - 6, UNIT.y + 6],
	],
	UNIT_H,
	1.3
);
// Outlet pipe to the standpipe, then the spout arm out over the dish.
pipe(UNIT.x + UNIT.w - 2, STAND[0], STAND[1]);
s.solid(cylinder(STAND[0], STAND[1], 6, 0, STAND_H, s.P, 28), { tone: "lo" });
s.halo({ x: DISH[0] - 22, y: DISH[1] - 22, w: 44, d: 44, r: 22 }, 0);
s.solid(cylinder(DISH[0], DISH[1], 22, 0, 3, s.P, 48, 0.6), { tone: "lo" });
s.solid(cylinder(DISH[0], DISH[1], 20, 3, 4, s.P, 48, 0.6));
s.line(ring(DISH[0], DISH[1], 16, 7, s.P, 40), { tone: "lo" });
s.solid(cylinder(DISH[0], DISH[1], 10, 7, 5, s.P, 32, 0.6), { lit: true });
s.solid(cylinder(DISH[0] - 2, STAND[1], 4, STAND_H - 12, 6, s.P, 20));
s.solid(
	slabOf(
		{ x: STAND[0] - 5, y: STAND[1] - 4, w: DISH[0] - STAND[0] + 5, d: 8, r: 3 },
		STAND_H - 6,
		6,
		s.P,
		4,
		0.4
	),
	{ tone: "lo" }
);

export const drawing = cardDrawing(s);
