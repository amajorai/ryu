import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Feature engineering: a cutting press. A raw log stands in the hopper on
 * top; the press turns it into identical square blocks that ride out on the
 * conveyor, each cut the same way. The newest block off the line is lit.
 */

const PLATE = { x: -92, y: -50, w: 184, d: 100, r: 8 };
const BODY = { x: -80, y: -38, w: 64, d: 64, r: 5 };
const BODY_H = 34;
const BELT = { x: -16, y: -18, w: 96, d: 28, r: 3 };
const BELT_H = 7;
const LOG: [number, number] = [-50, -8];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[LOG[0], LOG[1], BODY_H + 36],
]);

benchPlate(s, PLATE);
s.halo(BODY, 0);
s.solid(slabOf(BODY, 0, BODY_H, s.P, 6, 1));
s.line(
	faceRect(s, "y", BODY.y + BODY.d, BODY.x + 8, BODY.x + BODY.w - 8, 6, 22),
	{ tone: "lo" }
);
screws(
	s,
	[
		[BODY.x + 7, BODY.y + 7],
		[BODY.x + BODY.w - 7, BODY.y + BODY.d - 7],
	],
	BODY_H,
	1.4
);
// Hopper collar and the raw log standing in it.
s.solid(cylinder(LOG[0], LOG[1], 18, BODY_H, 5, s.P, 40, 0.6), { tone: "lo" });
s.line(ring(LOG[0], LOG[1], 15, BODY_H + 5, s.P, 40), { tone: "mid" });
s.solid(cylinder(LOG[0], LOG[1], 11, BODY_H + 5, 26, s.P, 28, 0.4));
s.line(ring(LOG[0], LOG[1], 6, BODY_H + 31, s.P, 24), { tone: "faint" });
s.line(ring(LOG[0], LOG[1], 3, BODY_H + 31, s.P, 16), { tone: "faint" });
lamp(s, [BODY.x + BODY.w - 9, BODY.y + 10], BODY_H, { radius: 1.8 });
// Feed wheel on the near corner of the top.
s.solid(cylinder(-28, 14, 7, BODY_H, 4, s.P, 32));
s.line(knurl(-28, 14, 7, BODY_H, BODY_H + 4, 30, s.P), { tone: "lo" });
// Conveyor out to the right.
s.halo(BELT, 0);
s.solid(slabOf(BELT, 0, BELT_H, s.P, 4, 0.6));
s.line(planOutline(insetPlan(BELT, 3), BELT_H, s.P, 3), { tone: "faint" });
for (const [index, x] of [-2, 22, 44, 62].entries()) {
	const plan = { x, y: BELT.y + 5, w: 17, d: 17, r: 1.5 };
	s.halo(plan, BELT_H);
	s.solid(slabOf(plan, BELT_H, 15, s.P, 3, 0.4), { lit: index === 3 });
}

export const drawing = cardDrawing(s);
