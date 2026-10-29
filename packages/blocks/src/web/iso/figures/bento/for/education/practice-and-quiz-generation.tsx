import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceLine,
	faceRect,
	knob,
	lamp,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Practice and quiz generation: one reading drops into the hopper (the lit
 * sheet) and the machine deals question cards into three trays on its
 * output rail, a short stack, a middle one and a tall one: the same topic at
 * three levels.
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const BODY = { x: -86, y: -38, w: 58, d: 62, r: 5 };
const BODY_H = 36;
const RAIL = { x: -26, y: -20, w: 104, d: 40, r: 3 };
const RAIL_H = 4;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-58, -10, BODY_H + 18],
]);

benchPlate(s, PLATE);
s.halo(BODY, 0);
s.solid(slabOf(BODY, 0, BODY_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BODY, 5), BODY_H, s.P, 4), { tone: "faint" });
// Hopper slot on top with the reading standing in it.
const slot = { x: -72, y: -12, w: 28, d: 5, r: 1 };
s.line(planOutline(slot, BODY_H, s.P, 2), { tone: "mid" });
s.solid(slabOf({ x: -70, y: -11, w: 24, d: 2, r: 0.4 }, BODY_H, 16, s.P, 2), {
	lit: true,
	crease: "none",
});
knob(s, [-74, 10], BODY_H, 5, 4);
lamp(s, [-50, 12], BODY_H, { radius: 1.8 });
// Exit mouth on the front-right face.
s.line(faceRect(s, "x", BODY.x + BODY.w, -14, 14, 6, 12), { tone: "lo" });
// Output rail with three trays.
s.halo(RAIL, 0);
s.solid(slabOf(RAIL, 0, RAIL_H, s.P, 4, 0.6));
screws(
	s,
	[
		[RAIL.x + 6, RAIL.y + 6],
		[RAIL.x + RAIL.w - 6, RAIL.y + RAIL.d - 6],
	],
	RAIL_H,
	1.4
);
const levels = [6, 12, 20];
levels.forEach((height, i) => {
	const tray = { x: -16 + i * 30, y: -14, w: 24, d: 28, r: 2 };
	s.solid(slabOf(tray, RAIL_H, 3, s.P, 3, 0.4), { tone: "lo" });
	const stack = insetPlan(tray, 3);
	const z0 = RAIL_H + 3;
	s.solid(slabOf(stack, z0, height, s.P, 2, 0.4));
	const front = stack.y + stack.d;
	for (let z = z0 + 3; z < z0 + height; z += 3) {
		s.line(faceLine(s, "y", front, stack.x, stack.x + stack.w, z), {
			tone: "faint",
		});
	}
});

export const drawing = cardDrawing(s);
