import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	sideRing,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	knob,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Built-in servers: a single chassis with two tools fixed into its deck at
 * the factory. On the left a small gantry with a stylus over a touch pad
 * (desktop automation); on the right a camera on a turret looking down at the
 * work (screen capture: a lens hood facing out, the lit record tally on top). Both are screwed in, not plugged in.
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const BODY = { x: -84, y: -38, w: 168, d: 70, r: 5 };
const BODY_H = 18;
const CAM: [number, number] = [52, -6];
const CAM_H = 30;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CAM[0], CAM[1], BODY_H + CAM_H + 10],
	[-46, -34, BODY_H + 42],
]);

benchPlate(s, PLATE);
s.halo(BODY, 0);
s.solid(slabOf(BODY, 0, BODY_H, s.P, 6, 1));
// Two drawer fronts on the near face, one per built-in tool.
const front = BODY.y + BODY.d;
s.line(faceRect(s, "y", front, BODY.x + 10, BODY.x + 74, 4, 14), {
	tone: "lo",
});
s.line(faceRect(s, "y", front, BODY.x + 94, BODY.x + 158, 4, 14), {
	tone: "lo",
});
// Left bay: touch pad under a gantry with a stylus carriage.
const pad = { x: -74, y: -26, w: 56, d: 46, r: 3 };
s.line(planOutline(pad, BODY_H, s.P, 3), { tone: "mid" });
s.solid(slabOf(insetPlan(pad, 4), BODY_H, 1.2, s.P, 3), { tone: "lo" });
for (const x of [-70, -22]) {
	s.solid(slabOf({ x: x - 3, y: -37, w: 6, d: 6, r: 1 }, BODY_H, 38, s.P, 2));
}
s.solid(
	slabOf({ x: -73, y: -37, w: 54, d: 6, r: 1 }, BODY_H + 38, 4, s.P, 2, 0.4)
);
// Stylus hanging from the carriage down onto the pad.
s.solid(cylinder(-45, -16, 1.4, BODY_H + 1.2, 28, s.P, 12));
s.solid(
	slabOf({ x: -51, y: -39, w: 12, d: 28, r: 2 }, BODY_H + 28, 12, s.P, 3)
);
s.solid(cylinder(-45, -16, 3, BODY_H + 24, 4, s.P, 16), { tone: "lo" });
// Right bay: camera turret on a collar.
s.line(ring(CAM[0], CAM[1], 18, BODY_H, s.P, 40), { tone: "lo" });
s.solid(cylinder(CAM[0], CAM[1], 14, BODY_H, 3, s.P, 40), { tone: "lo" });
s.solid(cylinder(CAM[0], CAM[1], 4, BODY_H + 3, CAM_H - 12, s.P, 20));
const head = { x: CAM[0] - 12, y: CAM[1] - 10, w: 24, d: 20, r: 3 };
s.halo(head, BODY_H + CAM_H - 9);
s.solid(slabOf(head, BODY_H + CAM_H - 9, 12, s.P, 4, 0.6));
// Lens hood on the near face, and the lit record tally on top.
const lensZ = BODY_H + CAM_H - 3;
s.solid(
	slabOf(
		{ x: CAM[0] - 7, y: head.y + head.d, w: 14, d: 6, r: 1 },
		lensZ - 6,
		12,
		s.P,
		2
	),
	{ tone: "lo" }
);
for (const radius of [4.5, 2.5]) {
	s.line(sideRing([CAM[0], head.y + head.d + 6, lensZ], radius, "y", s.P), {
		tone: "mid",
	});
}
s.solid(
	cylinder(head.x + 6, head.y + 5, 2.2, BODY_H + CAM_H + 3, 2.5, s.P, 20),
	{
		lit: true,
	}
);
knob(s, [CAM[0] + 26, CAM[1] + 18], BODY_H, 3.6, 4);
lamp(s, [BODY.x + BODY.w - 10, BODY.y + 8], BODY_H, { radius: 1.8 });
screws(
	s,
	[
		[BODY.x + 6, BODY.y + 6],
		[BODY.x + 6, BODY.y + BODY.d - 6],
		[BODY.x + BODY.w - 6, BODY.y + BODY.d - 6],
		[2, BODY.y + 6],
		[2, BODY.y + BODY.d - 6],
	],
	BODY_H,
	1.3
);

export const drawing = cardDrawing(s);
