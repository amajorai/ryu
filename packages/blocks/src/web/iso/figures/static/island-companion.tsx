import { boxCorners, slabOf } from "../../kit/iso-kit.ts";
import { benchPlate, faceRect, faceRules, ruler } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Ryu Island: a screen-aware companion that suggests the next step. A monitor
 * with an app open, and the island (the lit part): a pill floating just off
 * the top of the screen, opened out into a suggestion card.
 */

const WIDTH = 600;
const HEIGHT = 440;
const PLATE = { x: -110, y: -84, w: 210, d: 160, r: 8 };
const SCREEN = { x: -86, y: -62, w: 160, d: 6, r: 2 };
const SCREEN_Z = 26;
const SCREEN_H = 96;
const ISLAND = { x: -26, w: 40, h: 22, out: 16 };

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [SCREEN.x, SCREEN.y, SCREEN_Z + SCREEN_H + 4]],
	WIDTH,
	HEIGHT
);
const face = SCREEN.y + SCREEN.d;
const screenTop = SCREEN_Z + SCREEN_H;

function monitor() {
	const foot = { x: -28, y: -70, w: 44, d: 30, r: 6 };
	s.halo(foot, 0);
	s.solid(slabOf(foot, 0, 4, s.P, 6, 0.8));
	s.solid(
		slabOf({ x: -10, y: -68, w: 8, d: 6, r: 1.5 }, 4, SCREEN_Z + 8, s.P, 3, 0.4)
	);
	s.solid(slabOf(SCREEN, SCREEN_Z, SCREEN_H, s.P, 3, 0.8));
	s.line(
		faceRect(
			s,
			"y",
			face,
			SCREEN.x + 5,
			SCREEN.x + SCREEN.w - 5,
			SCREEN_Z + 5,
			screenTop - 5
		),
		{ tone: "mid" }
	);
	// The app underneath: a sidebar and a document.
	s.line(
		faceRect(
			s,
			"y",
			face,
			SCREEN.x + 9,
			SCREEN.x + 40,
			SCREEN_Z + 9,
			screenTop - 20
		)
	);
	faceRules(s, "y", face, SCREEN.x + 13, screenTop - 26, [20, 16, 22, 14], 7);
	faceRules(
		s,
		"y",
		face,
		SCREEN.x + 48,
		screenTop - 30,
		[90, 100, 76, 96, 60, 84],
		8
	);
	// The notch the island grows from.
	s.line(
		faceRect(
			s,
			"y",
			face,
			ISLAND.x + 10,
			ISLAND.x + ISLAND.w - 10,
			screenTop - 10,
			screenTop - 6
		),
		{ tone: "mid" }
	);
}

function island() {
	const y = face + ISLAND.out;
	const z = screenTop - ISLAND.h - 4;
	s.solid(
		slabOf(
			{ x: ISLAND.x - 12, y: y - 3, w: ISLAND.w + 24, d: 3, r: 1.5 },
			z,
			ISLAND.h,
			s.P,
			4,
			0.6
		),
		{ lit: true }
	);
	s.dots([s.at([ISLAND.x - 4, y, z + ISLAND.h - 6])], {
		size: 2.2,
		tone: "hi",
	});
	faceRules(s, "y", y, ISLAND.x + 4, z + ISLAND.h - 6, [36, 26], 6);
	s.line(
		faceRect(
			s,
			"y",
			y,
			ISLAND.x + ISLAND.w - 6,
			ISLAND.x + ISLAND.w + 8,
			z + 3,
			z + 8
		),
		{ tone: "mid" }
	);
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 14, w: 100, d: 7, r: 1 });
s.solid(slabOf({ x: -60, y: 28, w: 90, d: 30, r: 3 }, 0, 4, s.P, 4, 0.6));
monitor();
island();

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
