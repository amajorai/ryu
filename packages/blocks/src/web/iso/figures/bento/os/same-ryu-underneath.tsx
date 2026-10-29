import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRules, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Same Ryu underneath: two different machines bolted to one chassis. A tall
 * tower on the left and a low flat console on the right look nothing alike,
 * but both are driven by the same flywheel in the middle (the lit hub): one
 * set of agents, Core and permissions under either shell.
 */

const PLATE = { x: -96, y: -46, w: 192, d: 92, r: 8 };
const CHASSIS = { x: -84, y: -22, w: 168, d: 44, r: 4 };
const CHASSIS_H = 8;
const TOWER = { x: -74, y: -16, w: 36, d: 32, r: 3 };
const TOWER_H = 46;
const DESK = { x: 34, y: -18, w: 44, d: 36, r: 3 };
const DESK_H = 16;
const HUB_R = 18;
const SHAFT_Z = CHASSIS_H + 7;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, 0, CHASSIS_H + TOWER_H + 4],
]);

function shaft(x0: number, x1: number) {
	s.solid(
		slabOf({ x: x0, y: -2.5, w: x1 - x0, d: 5, r: 1 }, SHAFT_Z, 5, s.P, 2),
		{ tone: "lo" }
	);
}

benchPlate(s, PLATE);
s.halo(CHASSIS, 0);
s.solid(slabOf(CHASSIS, 0, CHASSIS_H, s.P, 6, 1));
screws(
	s,
	[
		[CHASSIS.x + 5, CHASSIS.y + 5],
		[CHASSIS.x + CHASSIS.w - 5, CHASSIS.y + CHASSIS.d - 5],
	],
	CHASSIS_H,
	1.4
);
// Tower shell, far left.
s.solid(slabOf(TOWER, CHASSIS_H, TOWER_H, s.P, 4, 1));
const towerTop = CHASSIS_H + TOWER_H;
s.line(planOutline(insetPlan(TOWER, 5), towerTop, s.P, 3), { tone: "faint" });
lamp(s, [TOWER.x + TOWER.w - 9, TOWER.y + 9], towerTop, { radius: 1.8 });
faceRules(
	s,
	"y",
	TOWER.y + TOWER.d,
	TOWER.x + 6,
	towerTop - 8,
	[24, 24, 24, 24, 24],
	4
);
shaft(TOWER.x + TOWER.w, -HUB_R + 2);
// The shared flywheel.
s.solid(cylinder(0, 0, HUB_R + 2, CHASSIS_H, 3, s.P, 40), { tone: "lo" });
s.solid(cylinder(0, 0, HUB_R, CHASSIS_H + 3, 14, s.P, 48, 0.6));
const hubTop = CHASSIS_H + 17;
s.line(knurl(0, 0, HUB_R, CHASSIS_H + 3, hubTop, 40, s.P), { tone: "lo" });
s.line(ring(0, 0, HUB_R - 4, hubTop, s.P, 40), { tone: "faint" });
s.solid(cylinder(0, 0, 9, hubTop, 5, s.P, 32, 0.6), { lit: true });
s.line(ring(0, 0, 3, hubTop + 5, s.P, 20), { tone: "lo" });
shaft(HUB_R - 2, DESK.x);
// Flat console shell, near right.
s.solid(slabOf(DESK, CHASSIS_H, DESK_H, s.P, 4, 1));
const deskTop = CHASSIS_H + DESK_H;
s.line(planOutline(insetPlan(DESK, 5), deskTop, s.P, 3), { tone: "lo" });
lamp(s, [DESK.x + DESK.w - 8, DESK.y + DESK.d - 8], deskTop, { radius: 1.8 });

export const drawing = cardDrawing(s);
