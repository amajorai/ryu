import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRules,
	jack,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Self-host Core and the Gateway: your own rack cabinet with two units slid
 * in, Core below and the Gateway above. One cable leaves the rack, only to
 * the provider port you route to (the lit lamp on the Gateway is its link).
 */

const PLATE = { x: -82, y: -48, w: 164, d: 90, r: 8 };
const RACK = { x: -66, y: -38, w: 60, d: 58, r: 4 };
const RACK_H = 76;
const FRONT = RACK.y + RACK.d;
const PORT = { x: 36, y: -24, w: 26, d: 22, r: 3 };
const PORT_H = 14;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[RACK.x, RACK.y, RACK_H + 2],
]);

function unit(z: number, height: number, lit: boolean) {
	const plan = { x: RACK.x + 5, y: FRONT - 3, w: RACK.w - 10, d: 10, r: 1.5 };
	s.solid(slabOf(plan, z, height, s.P, 2, 0.6));
	const face = plan.y + plan.d;
	faceRules(s, "y", face, plan.x + 6, z + height - 5, [26, 26, 26], 4);
	// The lamp sits on the part of the unit that stands proud of the rack.
	lamp(s, [plan.x + plan.w - 7, FRONT + 3.5], z + height, { lit, radius: 1.8 });
}

benchPlate(s, PLATE);
// Provider port at the back right: the one place a cable goes.
s.halo(PORT, 0);
s.solid(slabOf(PORT, 0, PORT_H, s.P, 4, 0.8));
s.line(planOutline(insetPlan(PORT, 4), PORT_H, s.P, 2), { tone: "faint" });
jack(s, [PORT.x + PORT.w / 2, PORT.y + PORT.d / 2], PORT_H);
// The rack cabinet.
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 6, 1.2));
s.line(planOutline(insetPlan(RACK, 5), RACK_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[RACK.x + 9, RACK.y + 9],
		[RACK.x + RACK.w - 9, RACK.y + RACK.d - 9],
	],
	RACK_H,
	1.5
);
unit(10, 22, false);
// The single uplink, out of the side and along the bench to the port.
s.wire(
	[RACK.x + RACK.w, -10, 54],
	[PORT.x + PORT.w / 2, PORT.y + PORT.d / 2, PORT_H],
	[
		[RACK.x + RACK.w + 0.5, -10, 2],
		[RACK.x + RACK.w + 8, -10, 0.5],
		[PORT.x - 8, -12, 0.5],
	],
	{ tone: "mid" }
);
unit(40, 22, true);

export const drawing = cardDrawing(s);
