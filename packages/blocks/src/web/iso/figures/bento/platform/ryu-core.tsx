import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Ryu Core: a small local engine on the bench. Three cylinders in one
 * crankcase (agents, sessions and tools all run on the same block) drive a
 * shaft out to the flywheel; its lit hub is the runtime turning.
 */

const PLATE = { x: -86, y: -46, w: 172, d: 92, r: 8 };
const BLOCK = { x: -66, y: -34, w: 78, d: 58, r: 5 };
const BLOCK_H = 22;
const WHEEL: [number, number] = [48, -4];
const WHEEL_R = 26;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[BLOCK.x, BLOCK.y, BLOCK_H + 16],
]);

benchPlate(s, PLATE);
// Crankcase on a low sump.
s.halo(BLOCK, 0);
s.solid(slabOf(insetPlan(BLOCK, -2), 0, 4, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(BLOCK, 4, BLOCK_H - 4, s.P, 6, 1));
s.line(planOutline(insetPlan(BLOCK, 4), BLOCK_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[BLOCK.x + 8, BLOCK.y + 8],
		[BLOCK.x + BLOCK.w - 8, BLOCK.y + 8],
		[BLOCK.x + 8, BLOCK.y + BLOCK.d - 8],
		[BLOCK.x + BLOCK.w - 8, BLOCK.y + BLOCK.d - 8],
	],
	BLOCK_H,
	1.4
);
// Three cylinders in a row, each with a finned barrel and a valve cap.
for (const x of [-52, -30, -8]) {
	const y = -14;
	s.solid(cylinder(x, y, 9, BLOCK_H, 10, s.P, 32, 0.6));
	for (const fz of [3, 5, 7]) {
		s.line(ring(x, y, 9, BLOCK_H + fz, s.P, 32), { tone: "lo" });
	}
	s.solid(cylinder(x, y, 5, BLOCK_H + 10, 4, s.P, 24), { tone: "lo" });
	s.line(ring(x, y, 2, BLOCK_H + 14, s.P, 16), { tone: "mid" });
}
// Status lamps and the throttle knob along the front of the deck.
lamp(s, [-56, 12], BLOCK_H, { radius: 1.8 });
lamp(s, [-46, 12], BLOCK_H, { radius: 1.8 });
lamp(s, [-36, 12], BLOCK_H, { radius: 1.8 });
knob(s, [-6, 10], BLOCK_H, 5, 4);
// Flywheel on its pedestal, spokes on the face.
s.halo({ x: WHEEL[0] - 12, y: WHEEL[1] - 12, w: 24, d: 24, r: 12 }, 0);
s.solid(cylinder(WHEEL[0], WHEEL[1], 12, 0, 4, s.P, 32, 0.6), { tone: "lo" });
s.solid(cylinder(WHEEL[0], WHEEL[1], WHEEL_R, 4, 7, s.P, 64, 0.8));
s.line(ring(WHEEL[0], WHEEL[1], WHEEL_R - 4, 11, s.P, 64), { tone: "lo" });
for (let k = 0; k < 6; k++) {
	const angle = (Math.PI * k) / 3 + 0.3;
	s.line(
		lineOnTop(
			[WHEEL[0] + Math.cos(angle) * 7, WHEEL[1] + Math.sin(angle) * 7],
			[
				WHEEL[0] + Math.cos(angle) * (WHEEL_R - 4),
				WHEEL[1] + Math.sin(angle) * (WHEEL_R - 4),
			],
			11,
			s.P
		),
		{ tone: "mid" }
	);
}
// Drive shaft from the crankcase into the hub.
s.solid(
	slabOf(
		{ x: BLOCK.x + BLOCK.w, y: WHEEL[1] - 3, w: WHEEL[0] - 12, d: 6, r: 1 },
		11,
		5,
		s.P,
		2,
		0.4
	),
	{ tone: "lo" }
);
s.solid(cylinder(WHEEL[0], WHEEL[1], 6, 11, 8, s.P, 28, 0.6), { lit: true });

export const drawing = cardDrawing(s);
