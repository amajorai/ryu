import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Spend and budget review: a fader desk, one channel per department. Each cap
 * sits at the department's spend; the stop bar across the slots is the
 * budget, and the one cap pushed past it (lit) is the line trending over.
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const DESK = { x: -84, y: -40, w: 168, d: 80, r: 5 };
const DESK_H = 14;
const LIMIT_Y = -8;
const SLOT_Y0 = -32;
const SLOT_D = 60;
const CAPS: [number, number][] = [4, 14, -26, 8, 20, 2].map(
	(y, i): [number, number] => [-60 + i * 22, y]
);
const OVER = 2;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, LIMIT_Y, DESK_H + 14],
]);

benchPlate(s, PLATE);
s.halo(DESK, 0);
s.solid(slabOf(DESK, 0, DESK_H, s.P, 6, 1));
s.line(planOutline(insetPlan(DESK, 5), DESK_H, s.P, 4), { tone: "faint" });
for (const [x] of CAPS) {
	s.solid(
		slabOf(
			{ x: x - 2, y: SLOT_Y0, w: 4, d: SLOT_D, r: 1 },
			DESK_H - 1,
			1,
			s.P,
			2
		),
		{
			tone: "lo",
			crease: "none",
		}
	);
}
// The budget stop: a bridge rail across every slot on two end posts, high
// enough that a cap pushed past it slides underneath.
const BRIDGE_Z = DESK_H + 11;
function cap(x: number, y: number) {
	const plan = { x: x - 7, y: y - 5, w: 14, d: 10, r: 2 };
	s.halo(plan, DESK_H);
	s.solid(slabOf(plan, DESK_H, 7, s.P, 3, 0.6), { lit: x === CAPS[OVER]?.[0] });
	s.line(lineOnTop([x - 5, y], [x + 5, y], DESK_H + 7, s.P), { tone: "mid" });
}
const sorted = byDepth(CAPS, s, DESK_H);
for (const [x, y] of sorted.filter(([, y]) => y < LIMIT_Y)) {
	cap(x, y);
}
for (const x of [-78, 60]) {
	s.solid(
		slabOf(
			{ x, y: LIMIT_Y - 2, w: 4, d: 4, r: 1 },
			DESK_H,
			BRIDGE_Z - DESK_H,
			s.P,
			2
		),
		{ tone: "lo" }
	);
}
s.solid(
	slabOf({ x: -80, y: LIMIT_Y - 2.5, w: 146, d: 5, r: 1 }, BRIDGE_Z, 3, s.P, 2),
	{ tone: "mid" }
);
for (const [x, y] of sorted.filter(([, y]) => y >= LIMIT_Y)) {
	cap(x, y);
}
for (let i = 0; i < 3; i++) {
	lamp(s, [72, 4 + i * 10], DESK_H, { radius: 2 });
}
screws(
	s,
	[
		[DESK.x + 8, DESK.y + DESK.d - 8],
		[DESK.x + DESK.w - 8, DESK.y + DESK.d - 8],
	],
	DESK_H,
	1.6
);

export const drawing = cardDrawing(s);
