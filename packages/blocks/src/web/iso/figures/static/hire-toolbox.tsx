import {
	boxCorners,
	corners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../kit/iso-kit.ts";
import { benchPlate, faceRect, ruler, screws } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Ryu Hire: bring in a specialist for one task. An open toolbox: a tray of
 * general tools in their slots, and the one specialist tool (the lit part)
 * lifted out for the job.
 */

const WIDTH = 640;
const HEIGHT = 420;
const PLATE = { x: -130, y: -80, w: 240, d: 150, r: 8 };
const BOX = { x: -100, y: -56, w: 150, d: 70, r: 4 };
const BOX_H = 34;
const LID_D = 6;
const TOOL_Z = BOX_H - 6;

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [BOX.x, BOX.y, BOX_H + 72]],
	WIDTH,
	HEIGHT
);

function box() {
	s.halo(BOX, 0);
	// Lid standing open along the back edge.
	s.solid(
		slabOf(
			{ x: BOX.x, y: BOX.y - LID_D, w: BOX.w, d: LID_D, r: 2 },
			BOX_H,
			66,
			s.P,
			3,
			0.6
		)
	);
	s.solid(slabOf(BOX, 0, BOX_H, s.P, 4, 1));
	const tray = insetPlan(BOX, 4);
	s.line(planOutline(tray, BOX_H, s.P, 3), { tone: "mid" });
	screws(s, corners(BOX, 3), BOX_H, 1.1);
	// Latches and handle on the front.
	const face = BOX.y + BOX.d;
	for (const x of [BOX.x + 20, BOX.x + BOX.w - 32]) {
		s.line(faceRect(s, "y", face, x, x + 12, BOX_H - 12, BOX_H - 4), {
			tone: "mid",
		});
	}
	s.line(faceRect(s, "y", face, BOX.x + 55, BOX.x + 95, 10, 14), {
		tone: "lo",
	});
}

function slot(x: number, y: number, w: number, d: number) {
	s.line(planOutline({ x, y, w, d, r: 1.5 }, BOX_H, s.P, 3), { tone: "lo" });
}

function wrench(x: number, y: number, z: number, lit = false) {
	s.solid(slabOf({ x, y: y - 2, w: 44, d: 4, r: 1.6 }, z, 2.4, s.P, 3), {
		lit,
		tone: lit ? "hi" : "mid",
	});
	s.solid(cylinder(x + 48, y, 6, z, 2.4, s.P, 28), {
		lit,
		tone: lit ? "hi" : "mid",
	});
	s.solid(cylinder(x - 4, y, 5, z, 2.4, s.P, 28), {
		lit,
		tone: lit ? "hi" : "mid",
	});
}

function screwdriver(x: number, y: number) {
	s.solid(slabOf({ x, y: y - 3, w: 22, d: 6, r: 3 }, TOOL_Z, 4, s.P, 4), {
		tone: "mid",
	});
	s.solid(
		slabOf(
			{ x: x + 22, y: y - 0.8, w: 26, d: 1.6, r: 0.6 },
			TOOL_Z + 1.2,
			1.6,
			s.P,
			2
		),
		{ crease: "none" }
	);
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 16, w: 120, d: 7, r: 1 });
box();
slot(BOX.x + 8, BOX.y + 8, 64, 12);
slot(BOX.x + 8, BOX.y + 26, 62, 10);
slot(BOX.x + 80, BOX.y + 8, 62, 10);
slot(BOX.x + 80, BOX.y + 24, 60, 14);
screwdriver(BOX.x + 10, BOX.y + 31);
screwdriver(BOX.x + 84, BOX.y + 13);
// A coil of wire and a tape measure in the front compartment.
s.solid(cylinder(BOX.x + 30, BOX.y + 54, 9, TOOL_Z, 6, s.P, 36, 0.6));
s.solid(
	slabOf(
		{ x: BOX.x + 100, y: BOX.y + 46, w: 18, d: 16, r: 3 },
		TOOL_Z,
		8,
		s.P,
		4,
		0.6
	)
);
s.line(
	lineOnTop(
		[BOX.x + 104, BOX.y + 54],
		[BOX.x + 114, BOX.y + 54],
		TOOL_Z + 8,
		s.P
	)
);
// The specialist tool, lifted out above its empty slot.
s.halo({ x: BOX.x + 10, y: BOX.y + 9, w: 52, d: 10, r: 4 }, BOX_H, 4);
wrench(BOX.x + 14, BOX.y + 14, BOX_H + 30, true);

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
