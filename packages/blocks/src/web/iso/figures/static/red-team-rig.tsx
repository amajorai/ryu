import {
	boxCorners,
	corners,
	cylinder,
	knurl,
	lineOnTop,
	radialTicks,
	ring,
	slabOf,
} from "../../kit/iso-kit.ts";
import { benchPlate, knob, ruler, screws } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Red Teaming: probe an agent for its weak points. A test rig: the part under
 * test clamped in a vise, a probe (the lit part) pressing down on it from a
 * column, and a dial gauge reading how far it gave.
 */

const WIDTH = 640;
const HEIGHT = 440;
const PLATE = { x: -140, y: -84, w: 260, d: 168, r: 8 };
const VISE = { x: -40, y: -20, w: 70, d: 40, r: 3 };
const VISE_H = 10;
const JAW_H = 18;
const PART = { x: -12, y: -12, w: 14, d: 24, r: 1.5 };
const COLUMN: [number, number] = [-5, -56];
const ARM_Z = 74;
const PROBE: [number, number] = [-5, 0];
const DIAL: [number, number] = [72, -40];
const DIAL_Z = 30;

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [COLUMN[0], COLUMN[1], ARM_Z + 20]],
	WIDTH,
	HEIGHT
);

function column() {
	const [x, y] = COLUMN;
	s.solid(
		slabOf({ x: x - 14, y: y - 14, w: 28, d: 28, r: 3 }, 0, 6, s.P, 4, 0.6),
		{ tone: "lo" }
	);
	screws(s, corners({ x: x - 14, y: y - 14, w: 28, d: 28, r: 3 }, 4), 6, 1.2);
	s.solid(cylinder(x, y, 5, 6, ARM_Z + 14 - 6, s.P, 28), { crease: "none" });
	s.solid(cylinder(x, y, 6, ARM_Z + 14, 2, s.P, 28));
	// The arm reaching over the vise, with a clamp collar on the column.
	s.solid(
		slabOf(
			{ x: x - 8, y: y - 8, w: 16, d: 16, r: 2.4 },
			ARM_Z - 2,
			12,
			s.P,
			4,
			0.5
		)
	);
	s.solid(
		slabOf(
			{ x: x - 4, y: y + 8, w: 8, d: PROBE[1] - y - 2, r: 1.5 },
			ARM_Z + 2,
			6,
			s.P,
			3,
			0.4
		)
	);
	knob(s, [x + 10, y], ARM_Z + 10, 2.6, 3);
}

function vise() {
	s.halo(VISE, 0);
	s.solid(slabOf(VISE, 0, VISE_H, s.P, 4, 0.8));
	screws(s, corners(VISE, 4), VISE_H, 1.2);
	// Fixed jaw, moving jaw and the screw with its handle.
	s.solid(
		slabOf(
			{ x: VISE.x + 4, y: VISE.y + 4, w: 12, d: VISE.d - 8, r: 1 },
			VISE_H,
			JAW_H,
			s.P,
			3,
			0.4
		)
	);
	s.solid(
		slabOf(
			{ x: PART.x + PART.w + 1, y: VISE.y + 4, w: 12, d: VISE.d - 8, r: 1 },
			VISE_H,
			JAW_H,
			s.P,
			3,
			0.4
		)
	);
	s.solid(cylinder(VISE.x + VISE.w + 6, 0, 3, VISE_H + 4, 3, s.P, 20), {
		tone: "lo",
	});
	s.line(
		lineOnTop(
			[VISE.x + VISE.w + 6, -12],
			[VISE.x + VISE.w + 6, 12],
			VISE_H + 7,
			s.P
		),
		{ tone: "mid" }
	);
	// The part under test between the jaws.
	s.solid(slabOf(PART, VISE_H, JAW_H + 4, s.P, 3, 0.5), {
		tone: "hi",
		crease: "lo",
	});
	s.line(
		lineOnTop(
			[PART.x + 2, 0],
			[PART.x + PART.w - 2, 0],
			VISE_H + JAW_H + 4,
			s.P
		),
		{ tone: "faint" }
	);
}

function probe() {
	const [x, y] = PROBE;
	const tipZ = VISE_H + JAW_H + 4;
	s.solid(cylinder(x, y, 4, ARM_Z - 8, 10, s.P, 24), { crease: "none" });
	s.solid(cylinder(x, y, 1.6, tipZ + 2, ARM_Z - 8 - tipZ - 2, s.P, 16), {
		lit: true,
		crease: "none",
	});
	s.solid(cylinder(x, y, 2.4, tipZ, 2, s.P, 16), { lit: true });
}

function dial() {
	const [x, y] = DIAL;
	const top = DIAL_Z + 5;
	s.solid(
		slabOf({ x: x - 8, y: y - 8, w: 16, d: 16, r: 2 }, 0, 4, s.P, 4, 0.5)
	);
	s.solid(cylinder(x, y, 2.6, 4, DIAL_Z - 4, s.P, 20), { crease: "none" });
	s.solid(cylinder(x, y, 16, DIAL_Z, 5, s.P, 64, 0.8), {
		tone: "hi",
		crease: "lo",
	});
	s.line(knurl(x, y, 16, top - 2.4, top, 72, s.P, 0.3));
	s.line(ring(x, y, 14, top, s.P, 64));
	const ticks = radialTicks(x, y, 13, 50, 5, top, [1.2, 2.6], s.P);
	s.line(ticks.minor);
	s.line(ticks.major, { tone: "mid" });
	s.line(lineOnTop([x, y], [x + 9, y - 6], top + 0.2, s.P), {
		tone: "lit",
		free: "end",
	});
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 16, w: 130, d: 7, r: 1 });
s.wire(
	[DIAL[0] - 8, DIAL[1], 2],
	[COLUMN[0] + 14, COLUMN[1], 3],
	[
		[DIAL[0] - 16, DIAL[1], 0.8],
		[COLUMN[0] + 22, COLUMN[1], 0.8],
	],
	{
		tone: "mid",
	}
);
column();
dial();
vise();
probe();

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
