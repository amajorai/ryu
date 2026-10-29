import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../kit/iso-kit.ts";
import {
	benchPlate,
	byDepth,
	jack,
	knob,
	lamp,
	ruler,
	screws,
} from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Agents: build your own, every part swappable. A robot kit laid out
 * exploded above its chassis: the drive base on its wheels, the body, two arm
 * modules beside it, and the head (the lit part) hovering at the top.
 */

const WIDTH = 600;
const HEIGHT = 460;
const PLATE = { x: -120, y: -84, w: 220, d: 160, r: 8 };
const BASE = { x: -40, y: -30, w: 60, d: 50, r: 6 };
const BODY = { x: -34, y: -24, w: 48, d: 38, r: 5 };
const BODY_Z = 34;
const HEAD = { x: -26, y: -18, w: 32, d: 26, r: 6 };
const HEAD_Z = 92;
const ARMS: [number, number][] = [
	[-76, -40],
	[56, 30],
];

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [HEAD.x, HEAD.y, HEAD_Z + 26]],
	WIDTH,
	HEIGHT
);

function base() {
	for (const [x, y] of byDepth<[number, number]>(
		[
			[BASE.x + 10, BASE.y - 2],
			[BASE.x + BASE.w - 10, BASE.y - 2],
			[BASE.x + 10, BASE.y + BASE.d + 2],
			[BASE.x + BASE.w - 10, BASE.y + BASE.d + 2],
		],
		s
	)) {
		s.solid(cylinder(x, y, 8, 0, 6, s.P, 32, 0.6), { tone: "lo" });
		s.line(ring(x, y, 3, 6, s.P, 16), { tone: "mid" });
	}
	s.halo(BASE, 6);
	s.solid(slabOf(BASE, 6, 10, s.P, 5, 0.8));
	screws(
		s,
		[
			[BASE.x + 6, BASE.y + 6],
			[BASE.x + BASE.w - 6, BASE.y + BASE.d - 6],
		],
		16,
		1.2
	);
	jack(s, [BASE.x + BASE.w / 2 - 8, BASE.y + BASE.d / 2], 16);
	jack(s, [BASE.x + BASE.w / 2 + 2, BASE.y + BASE.d / 2], 16);
}

function body() {
	s.solid(slabOf(BODY, BODY_Z, 34, s.P, 5, 1));
	const top = BODY_Z + 34;
	s.line(planOutline(insetPlan(BODY, 5), top, s.P, 3), { tone: "faint" });
	knob(s, [BODY.x + BODY.w - 9, BODY.y + 9], top, 3, 3);
	lamp(s, [BODY.x + 9, BODY.y + 9], top);
	for (let i = 0; i < 4; i++) {
		s.line(
			lineOnTop(
				[BODY.x + 10, BODY.y + 18 + i * 3],
				[BODY.x + 30, BODY.y + 18 + i * 3],
				top,
				s.P
			)
		);
	}
	s.solid(
		cylinder(BODY.x + BODY.w / 2, BODY.y + BODY.d / 2, 4, top, 6, s.P, 20),
		{ crease: "none" }
	);
}

function arm([x, y]: [number, number]) {
	const plan = { x: x - 10, y: y - 10, w: 20, d: 20, r: 4 };
	s.halo(plan, 0);
	s.solid(cylinder(x, y, 9, 0, 6, s.P, 32, 0.6), { tone: "lo" });
	s.solid(slabOf({ x: x - 4, y: y - 4, w: 8, d: 8, r: 2 }, 6, 30, s.P, 3, 0.4));
	s.solid(cylinder(x, y, 6, 36, 5, s.P, 28, 0.6));
	s.wire([x - 3, y, 41], [x + 4, y + 2, 47], [[x - 6, y, 46]], { tone: "mid" });
}

function head() {
	s.solid(slabOf(HEAD, HEAD_Z, 22, s.P, 8, 1.2), { lit: true });
	const face = HEAD.y + HEAD.d;
	s.dots(
		[
			s.at([HEAD.x + 11, face, HEAD_Z + 13]),
			s.at([HEAD.x + 21, face, HEAD_Z + 13]),
		],
		{ size: 1.6, tone: "hi" }
	);
	s.solid(
		cylinder(
			HEAD.x + HEAD.w / 2,
			HEAD.y + HEAD.d / 2,
			1.2,
			HEAD_Z + 22,
			10,
			s.P,
			12
		),
		{ crease: "none" }
	);
	s.solid(
		cylinder(
			HEAD.x + HEAD.w / 2,
			HEAD.y + HEAD.d / 2,
			2.4,
			HEAD_Z + 32,
			2.4,
			s.P,
			16
		)
	);
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 14, w: 100, d: 7, r: 1 });
const [backArm, frontArm] = ARMS;
if (backArm) {
	arm(backArm);
}
base();
body();
head();
if (frontArm) {
	arm(frontArm);
}

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
