import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	radialTicks,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRules,
	knob,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Built on Ryu: the agent is one unit on a standard Ryu chassis. Three stock
 * cartridges plug into the same chassis beside it: a platter stack for
 * memory, a selector for model routing and a lock for Gateway security. The
 * chassis's power lamp (lit) is what everything runs on.
 */

const PLATE = { x: -96, y: -56, w: 192, d: 112, r: 8 };
const CHASSIS = { x: -82, y: -44, w: 164, d: 86, r: 5 };
const CH_H = 12;
const UNIT = { x: -70, y: -34, w: 58, d: 60, r: 4 };
const UNIT_H = 32;
const CART_X = 6;
const CART_W = 32;
const CART_D = 24;
const CART_H = 12;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[UNIT.x, UNIT.y, CH_H + UNIT_H + 4],
]);

benchPlate(s, PLATE);
s.halo(CHASSIS, 0, 7);
s.solid(slabOf(CHASSIS, 0, CH_H, s.P, 6, 1));
s.line(planOutline(insetPlan(CHASSIS, 4), CH_H, s.P, 3), { tone: "faint" });
faceRules(s, "y", CHASSIS.y + CHASSIS.d, CHASSIS.x + 10, CH_H - 4, [40, 28], 4);
lamp(s, [CHASSIS.x + CHASSIS.w - 12, CHASSIS.y + CHASSIS.d - 10], CH_H, {
	lit: true,
	radius: 4,
});
// The agent unit on the back left.
s.halo(UNIT, CH_H);
s.solid(slabOf(UNIT, CH_H, UNIT_H, s.P, 6, 0.8));
const unitTop = CH_H + UNIT_H;
s.line(planOutline(insetPlan(UNIT, 5), unitTop, s.P, 3), { tone: "faint" });
faceRules(s, "y", UNIT.y + UNIT.d, UNIT.x + 8, unitTop - 8, [36, 24, 30], 4);
knob(s, [UNIT.x + 18, UNIT.y + 20], unitTop, 5, 4);
screws(
	s,
	[
		[UNIT.x + UNIT.w - 9, UNIT.y + 9],
		[UNIT.x + UNIT.w - 9, UNIT.y + UNIT.d - 9],
	],
	unitTop,
	1.4
);

function cartridge(y: number) {
	const plan = { x: CART_X, y, w: CART_W, d: CART_D, r: 2 };
	s.line(planOutline(insetPlan(plan, -1.5), CH_H, s.P, 2), { tone: "mid" });
	s.halo(plan, CH_H);
	s.solid(slabOf(plan, CH_H, CART_H, s.P, 3, 0.6));
	return [CART_X + CART_W / 2, y + CART_D / 2, CH_H + CART_H] as const;
}

// Memory: a stack of platters on a spindle.
const [mx, my, mz] = cartridge(-38);
s.solid(cylinder(mx, my, 3, mz, 14, s.P, 16), { tone: "lo" });
for (let index = 0; index < 4; index++) {
	s.solid(cylinder(mx, my, 10.5, mz + 1 + index * 3.2, 1.4, s.P, 36), {
		tone: index === 3 ? "hi" : "lo",
	});
}
s.solid(cylinder(mx, my, 3, mz + 13.8, 1.6, s.P, 16));
// Routing: a rotary selector with its positions.
const [rx, ry, rz] = cartridge(-11);
const routes = radialTicks(rx, ry, 10.5, 6, 1, rz, [3, 3], s.P);
s.line(routes.major, { tone: "mid" });
knob(s, [rx, ry], rz, 6, 6);
// Security: a lock cylinder with its keyway.
const [lx, ly, lz] = cartridge(16);
s.solid(cylinder(lx, ly, 9, lz, 3, s.P, 32), { tone: "lo" });
s.solid(cylinder(lx, ly, 7, lz + 3, 4, s.P, 32));
s.line(ring(lx, ly, 4.4, lz + 7, s.P, 20), { tone: "lo" });
s.line(lineOnTop([lx - 3.6, ly], [lx + 3.6, ly], lz + 7, s.P), { tone: "hi" });
// A spare slot at the front, ready for the next cartridge.
s.line(planOutline({ x: 50, y: -36, w: 22, d: 52, r: 2 }, CH_H, s.P, 2), {
	tone: "lo",
});

export const drawing = cardDrawing(s);
