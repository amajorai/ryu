import { boxCorners, slabOf } from "../../kit/iso-kit.ts";
import { benchPlate, faceRect, faceRules, ruler } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * OS: a desktop workspace for agents, apps and windows. A monitor on its
 * stand, its windows pulled forward out of the screen as a stack of panes,
 * the front one (the lit part) the agent at work.
 */

const WIDTH = 600;
const HEIGHT = 460;
const PLATE = { x: -110, y: -84, w: 210, d: 168, r: 8 };
const SCREEN = { x: -80, y: -60, w: 150, d: 6, r: 2 };
const SCREEN_Z = 30;
const SCREEN_H = 92;
const PANES = [
	{ dx: 10, dz: 40, w: 70, h: 40, out: 14 },
	{ dx: 60, dz: 24, w: 66, h: 46, out: 28 },
	{ dx: 28, dz: 14, w: 60, h: 36, out: 44 },
];

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [SCREEN.x, SCREEN.y, SCREEN_Z + SCREEN_H + 4]],
	WIDTH,
	HEIGHT
);
const face = SCREEN.y + SCREEN.d;

function monitor() {
	const foot = { x: -26, y: -66, w: 42, d: 30, r: 6 };
	s.halo(foot, 0);
	s.solid(slabOf(foot, 0, 4, s.P, 6, 0.8));
	s.solid(
		slabOf({ x: -9, y: -64, w: 8, d: 6, r: 1.5 }, 4, SCREEN_Z + 8, s.P, 3, 0.4)
	);
	s.solid(slabOf(SCREEN, SCREEN_Z, SCREEN_H, s.P, 3, 0.8));
	s.line(
		faceRect(
			s,
			"y",
			face,
			SCREEN.x + 5,
			SCREEN.x + SCREEN.w - 5,
			SCREEN_Z + 6,
			SCREEN_Z + SCREEN_H - 5
		),
		{ tone: "mid" }
	);
	// Menu bar and dock on the screen itself.
	s.line(
		faceRect(
			s,
			"y",
			face,
			SCREEN.x + 5,
			SCREEN.x + SCREEN.w - 5,
			SCREEN_Z + SCREEN_H - 11,
			SCREEN_Z + SCREEN_H - 5
		)
	);
	s.line(
		faceRect(
			s,
			"y",
			face,
			SCREEN.x + 50,
			SCREEN.x + 100,
			SCREEN_Z + 8,
			SCREEN_Z + 15
		)
	);
	s.dots(
		[0, 1, 2, 3, 4].map((k) =>
			s.at([SCREEN.x + 56 + k * 9, face, SCREEN_Z + 11.5])
		),
		{ size: 1, tone: "mid" }
	);
}

function pane(index: number) {
	const p = PANES[index];
	if (!p) {
		return;
	}
	const lit = index === PANES.length - 1;
	const x = SCREEN.x + p.dx;
	const y = face + p.out;
	const z = SCREEN_Z + p.dz;
	s.solid(slabOf({ x, y: y - 2, w: p.w, d: 2, r: 0.6 }, z, p.h, s.P, 2), {
		lit,
		tone: lit ? "hi" : "mid",
		crease: "none",
	});
	s.line(faceRect(s, "y", y, x + 2, x + p.w - 2, z + p.h - 7, z + p.h - 2), {
		tone: lit ? "mid" : "lo",
	});
	s.dots(
		[0, 1, 2].map((k) => s.at([x + 5 + k * 3.4, y, z + p.h - 4.5])),
		{ size: 0.7, tone: "mid" }
	);
	faceRules(
		s,
		"y",
		y,
		x + 6,
		z + p.h - 13,
		[p.w * 0.6, p.w * 0.45, p.w * 0.55],
		6
	);
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 14, w: 100, d: 7, r: 1 });
// A keyboard and a mouse in front of the stand.
s.solid(slabOf({ x: -60, y: 30, w: 90, d: 30, r: 3 }, 0, 4, s.P, 4, 0.6));
s.solid(slabOf({ x: 48, y: 36, w: 12, d: 18, r: 6 }, 0, 4, s.P, 6, 0.6));
monitor();
for (let i = 0; i < PANES.length; i++) {
	pane(i);
}

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
