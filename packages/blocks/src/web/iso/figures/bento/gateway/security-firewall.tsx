import { boxCorners, cylinder, slabOf } from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Security firewall: a checkpoint on a conveyor. Requests ride in from the
 * back; the barrier arm is down and holds the first one (the lit block) until
 * it has been checked. The one past the gate has been let through.
 */

const PLATE = { x: -96, y: -44, w: 192, d: 88, r: 8 };
const RAIL = { x: -84, y: -12, w: 168, d: 24, r: 3 };
const RAIL_H = 6;
const GATE_X = 22;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [GATE_X, -30, 50]]);

function request(x: number, lit = false) {
	const plan = { x: x - 12, y: RAIL.y + 3, w: 24, d: 18, r: 2 };
	s.halo(plan, RAIL_H);
	s.solid(slabOf(plan, RAIL_H, 15, s.P, 4, 0.6), { lit });
}

benchPlate(s, PLATE);
s.solid(slabOf(RAIL, 0, RAIL_H, s.P, 4, 0.6));
screws(
	s,
	[
		[RAIL.x + 6, 0],
		[RAIL.x + RAIL.w - 6, 0],
	],
	RAIL_H,
	1.4
);
// Gate post behind the rail, with the arm lowered across it.
const post = { x: GATE_X - 7, y: RAIL.y - 22, w: 14, d: 14, r: 2 };
s.halo(post, 0);
s.solid(slabOf(post, 0, 44, s.P, 4, 0.8));
lamp(s, [GATE_X, RAIL.y - 15], 44, { lit: true, radius: 2.2 });
request(-62);
request(-30);
request(0, true);
s.solid(cylinder(GATE_X, RAIL.y - 15, 4, 28, 7, s.P, 24), { tone: "lo" });
s.solid(
	slabOf({ x: GATE_X - 2.5, y: RAIL.y - 10, w: 5, d: 46, r: 1 }, 30, 4, s.P, 2)
);
request(60);

export const drawing = cardDrawing(s);
