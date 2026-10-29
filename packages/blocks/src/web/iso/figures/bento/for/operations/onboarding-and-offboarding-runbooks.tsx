import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Onboarding and offboarding runbooks: a step console. Each provisioning
 * step is a toggle in a row, thrown forward once it has run, with a lamp in
 * front of it. The run ends at the keyed sign-off switch, whose key (lit) is
 * turned only by the person who approves it.
 */

const PLATE = { x: -104, y: -48, w: 208, d: 96, r: 8 };
const DESK = { x: -92, y: -34, w: 184, d: 58, r: 4 };
const DESK_H = 14;
const STEPS = [-72, -50, -28, -6, 16];
const DONE = 3;
const KEY: [number, number] = [62, -6];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[KEY[0], KEY[1], 40],
]);

benchPlate(s, PLATE);
s.halo(DESK, 0);
s.solid(slabOf(DESK, 0, DESK_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(DESK, 5), DESK_H, s.P, 4), { tone: "faint" });
faceRules(s, "y", DESK.y + DESK.d, DESK.x + 10, 9, [60, 40], 4);
screws(
	s,
	[
		[DESK.x + 7, DESK.y + 7],
		[DESK.x + DESK.w - 7, DESK.y + DESK.d - 7],
	],
	DESK_H,
	1.4
);
// Toggle plates and levers: upright while waiting, laid forward once run.
for (const [i, x] of STEPS.entries()) {
	s.solid(
		slabOf({ x: x - 6, y: -22, w: 12, d: 18, r: 2 }, DESK_H, 1.5, s.P, 3)
	);
	if (i < DONE) {
		s.solid(
			slabOf({ x: x - 2, y: -15, w: 4, d: 15, r: 1 }, DESK_H + 1.5, 3, s.P, 2),
			{ tone: "mid" }
		);
		s.solid(cylinder(x, 0, 2.6, DESK_H, 5, s.P, 16));
	} else {
		s.solid(
			slabOf({ x: x - 2, y: -15, w: 4, d: 4, r: 1 }, DESK_H + 1.5, 12, s.P, 2),
			{ tone: "lo" }
		);
		s.solid(cylinder(x, -13, 2.6, DESK_H + 13.5, 2.5, s.P, 16));
	}
}
for (const x of STEPS) {
	lamp(s, [x, 8], DESK_H, { radius: 2 });
}
// The keyed sign-off switch: a lock barrel with its key (lit) standing in it.
s.solid(cylinder(KEY[0], KEY[1], 12, DESK_H, 2, s.P, 36), { tone: "lo" });
s.solid(cylinder(KEY[0], KEY[1], 9, DESK_H + 2, 4, s.P, 36, 0.6));
s.line(ring(KEY[0], KEY[1], 6, DESK_H + 6, s.P, 28), { tone: "mid" });
s.solid(
	slabOf(
		{ x: KEY[0] - 1.5, y: KEY[1] - 8, w: 3, d: 16, r: 4 },
		DESK_H + 6,
		16,
		s.P,
		6
	),
	{ lit: true }
);

export const drawing = cardDrawing(s);
