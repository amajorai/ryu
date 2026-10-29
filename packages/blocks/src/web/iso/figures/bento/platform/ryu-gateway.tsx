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
	faceRect,
	faceRules,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Ryu Gateway: one inlet pipe into a valve manifold. Every call comes in
 * through the same duct, the handwheel on top (the lit part) sets where it
 * goes, three outlets lead to the models and tools, and a counter on the
 * body logs every pass.
 */

const PLATE = { x: -98, y: -42, w: 196, d: 84, r: 8 };
const BODY = { x: -30, y: -30, w: 40, d: 58, r: 4 };
const BODY_H = 30;
const WHEEL: [number, number] = [-10, -8];
const WHEEL_Z = BODY_H + 8;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[WHEEL[0], WHEEL[1], WHEEL_Z + 4],
]);

function duct(x: number, y: number, w: number, flange: number) {
	// A square duct on two saddles, with a flange collar at its outer end.
	for (const sx of [x + 10, x + w - 16]) {
		s.solid(slabOf({ x: sx, y: y - 2, w: 6, d: 14, r: 1 }, 0, 6, s.P, 2), {
			tone: "lo",
		});
	}
	s.solid(slabOf({ x, y, w, d: 10, r: 1.5 }, 6, 10, s.P, 3, 0.4));
	s.solid(
		slabOf({ x: flange, y: y - 2, w: 4, d: 14, r: 1 }, 4, 14, s.P, 2, 0.4)
	);
}

benchPlate(s, PLATE);
// Inlet from the back-left into the valve body.
duct(-90, -6, 60, -90);
// Valve body, bolted down, with a gauge and the audit counter on top.
s.halo(BODY, 0);
s.solid(slabOf(insetPlan(BODY, -2), 0, 4, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(BODY, 4, BODY_H - 4, s.P, 6, 1));
screws(
	s,
	[
		[BODY.x + 6, BODY.y + 6],
		[BODY.x + BODY.w - 6, BODY.y + BODY.d - 6],
	],
	BODY_H,
	1.3
);
const face = BODY.y + BODY.d;
s.line(faceRect(s, "y", face, BODY.x + 6, BODY.x + BODY.w - 6, 10, 22), {
	tone: "mid",
});
faceRules(s, "y", face, BODY.x + 10, 18, [18, 12], 4);
// Audit counter: a small box with its tally window.
const counter = { x: -24, y: 8, w: 22, d: 14, r: 2 };
s.solid(slabOf(counter, BODY_H, 8, s.P, 3, 0.4), { tone: "lo" });
s.line(planOutline(insetPlan(counter, 3), BODY_H + 8, s.P, 2), {
	tone: "mid",
});
lamp(s, [4, 16], BODY_H, { radius: 1.6 });
// Handwheel on its stem.
s.solid(cylinder(WHEEL[0], WHEEL[1], 3, BODY_H, 8, s.P, 20), { tone: "lo" });
s.solid(cylinder(WHEEL[0], WHEEL[1], 15, WHEEL_Z, 3, s.P, 48, 0.4), {
	lit: true,
});
s.line(ring(WHEEL[0], WHEEL[1], 11, WHEEL_Z + 3, s.P, 40), { tone: "lo" });
for (const [dx, dy] of [
	[1, 0],
	[-0.5, 0.87],
	[-0.5, -0.87],
] as const) {
	s.line(
		lineOnTop(
			[WHEEL[0] - dx * 11, WHEEL[1] - dy * 11],
			[WHEEL[0] + dx * 11, WHEEL[1] + dy * 11],
			WHEEL_Z + 3,
			s.P
		),
		{ tone: "mid" }
	);
}
s.solid(cylinder(WHEEL[0], WHEEL[1], 3.4, WHEEL_Z + 3, 2, s.P, 20), {
	tone: "lo",
});
// Three outlets, far to near, each with a small pressure gauge.
for (const y of [-26, -5, 16]) {
	duct(10, y, 76, 82);
	const gx = 50;
	const gy = y + 5;
	s.solid(cylinder(gx, gy, 5, 16, 3, s.P, 28), { tone: "lo" });
	const ticks = radialTicks(gx, gy, 4, 12, 4, 19, [1, 1.6], s.P);
	s.line(ticks.major, { tone: "mid" });
}

export const drawing = cardDrawing(s);
