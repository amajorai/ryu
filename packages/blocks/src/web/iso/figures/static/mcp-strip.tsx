import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../kit/iso-kit.ts";
import { benchPlate, byDepth, faceRect, lamp, ruler, screws } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * MCP: one standard plug for every tool. A terminal strip of identical
 * sockets: three different tools are plugged in with the same plug, and one
 * plug (the lit part) is on its way into a free socket.
 */

const WIDTH = 640;
const HEIGHT = 420;
const PLATE = { x: -140, y: -84, w: 270, d: 168, r: 8 };
const STRIP = { x: -100, y: -10, w: 190, d: 26, r: 4 };
const STRIP_H = 10;
const SOCKETS = 6;
const SOCKET_GAP = 30;
const PLUGGED = [0, 2, 3];
const INCOMING = 5;
const TOOLS: [number, number, number][] = [
	[-108, -66, 0],
	[-30, -70, 2],
	[34, -66, 3],
];

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [0, -70, 40]],
	WIDTH,
	HEIGHT
);
const socketX = (i: number) => STRIP.x + 14 + i * SOCKET_GAP;

function plug(x: number, y: number, z: number, lit = false) {
	s.solid(
		slabOf({ x: x - 6, y: y - 5, w: 12, d: 10, r: 2 }, z, 9, s.P, 4, 0.6),
		{ lit, tone: lit ? "hi" : "mid" }
	);
	s.solid(cylinder(x, y - 5, 2.4, z + 3, 3, s.P, 16), { crease: "none" });
}

function strip() {
	s.halo(STRIP, 0);
	s.solid(slabOf(STRIP, 0, STRIP_H, s.P, 4, 0.8));
	screws(
		s,
		[
			[STRIP.x + 5, STRIP.y + STRIP.d / 2],
			[STRIP.x + STRIP.w - 5, STRIP.y + STRIP.d / 2],
		],
		STRIP_H,
		1.2
	);
	for (let i = 0; i < SOCKETS; i++) {
		const x = socketX(i);
		const y = STRIP.y + STRIP.d / 2;
		s.line(
			planOutline({ x: x - 7, y: y - 6, w: 14, d: 12, r: 2 }, STRIP_H, s.P, 3),
			{ tone: "mid" }
		);
		s.line(ring(x - 2.5, y, 0.9, STRIP_H, s.P, 10));
		s.line(ring(x + 2.5, y, 0.9, STRIP_H, s.P, 10));
	}
	lamp(s, [STRIP.x + STRIP.w - 14, STRIP.y + STRIP.d / 2], STRIP_H, {
		lit: true,
		radius: 1.8,
	});
	s.line(
		faceRect(s, "y", STRIP.y + STRIP.d, STRIP.x + 10, STRIP.x + 40, 3, 6),
		{ tone: "faint" }
	);
}

function tool([x, y, kind]: [number, number, number]) {
	const plan = { x: x - 18, y: y - 12, w: 36, d: 26, r: 3 };
	s.halo(plan, 0);
	if (kind === 0) {
		s.solid(slabOf(plan, 0, 18, s.P, 4, 0.8));
		s.line(planOutline(insetPlan(plan, 4), 18, s.P, 3), { tone: "faint" });
	} else if (kind === 2) {
		s.solid(slabOf(plan, 0, 8, s.P, 4, 0.8));
		s.solid(cylinder(x, y, 9, 8, 14, s.P, 40, 0.6));
		s.line(ring(x, y, 6, 22, s.P, 32));
	} else {
		s.solid(slabOf(plan, 0, 26, s.P, 4, 0.8));
		for (let i = 0; i < 4; i++) {
			s.line(
				lineOnTop(
					[plan.x + 6, plan.y + 6 + i * 4],
					[plan.x + 30, plan.y + 6 + i * 4],
					26,
					s.P
				)
			);
		}
	}
	lamp(
		s,
		[plan.x + plan.w - 6, plan.y + 6],
		kind === 0 ? 18 : kind === 2 ? 8 : 26,
		{ radius: 1.6 }
	);
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 16, w: 140, d: 7, r: 1 });
for (const t of byDepth(TOOLS, s)) {
	tool(t);
}
TOOLS.forEach(([x, y], index) => {
	const target = socketX(PLUGGED[index] ?? 0);
	s.wire(
		[x, y + 12, 3],
		[target, STRIP.y + 6, STRIP_H + 4],
		[
			[x, y + 24, 0.8],
			[target, y + 24, 0.8],
		]
	);
});
strip();
for (const i of PLUGGED) {
	plug(socketX(i), STRIP.y + STRIP.d / 2, STRIP_H);
}
const incoming = socketX(INCOMING);
plug(incoming, STRIP.y + STRIP.d / 2, STRIP_H + 16, true);
s.wire(
	[incoming, STRIP.y + STRIP.d / 2 + 5, STRIP_H + 20],
	[incoming + 20, STRIP.y + STRIP.d + 34, 3],
	[[incoming + 6, STRIP.y + STRIP.d + 14, 22]]
);

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
