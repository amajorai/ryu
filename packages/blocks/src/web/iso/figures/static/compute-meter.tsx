import {
	boxCorners,
	corners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	radialTicks,
	ring,
	slabOf,
} from "../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, ruler, screws } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Ryu Compute: rent compute for one bounded run. A metered power unit with an
 * hour dial and a timer knob feeds a finned processor block; the running lamp
 * (the lit part) shows the run on the clock.
 */

const WIDTH = 640;
const HEIGHT = 420;
const PLATE = { x: -130, y: -80, w: 240, d: 150, r: 8 };
const METER = { x: -112, y: -60, w: 70, d: 60, r: 4 };
const METER_H = 26;
const CPU = { x: 6, y: -50, w: 76, d: 64, r: 3 };
const CPU_H = 8;
const FINS = 11;

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [CPU.x, CPU.y, 40]],
	WIDTH,
	HEIGHT
);

function meter() {
	s.halo(METER, 0);
	s.solid(slabOf(METER, 0, METER_H, s.P, 5, 1));
	screws(s, corners(METER, 4), METER_H, 1.2);
	const [cx, cy] = [METER.x + 26, METER.y + 28];
	s.solid(cylinder(cx, cy, 20, METER_H, 3, s.P, 64, 0.6), {
		tone: "hi",
		crease: "lo",
	});
	s.line(ring(cx, cy, 17.5, METER_H + 3, s.P, 64));
	const ticks = radialTicks(cx, cy, 16.5, 60, 5, METER_H + 3, [1.2, 2.8], s.P);
	s.line(ticks.minor);
	s.line(ticks.major, { tone: "mid" });
	s.line(lineOnTop([cx, cy], [cx + 11, cy - 7], METER_H + 3.2, s.P), {
		tone: "lit",
		free: "end",
	});
	s.line(ring(cx, cy, 1.4, METER_H + 3, s.P, 16), { tone: "mid" });
	knob(s, [METER.x + 58, METER.y + 18], METER_H, 4.6, 5);
	lamp(s, [METER.x + 58, METER.y + 40], METER_H, { lit: true });
	// Outlet on the right face for the lead.
	s.solid(
		slabOf(
			{ x: METER.x + METER.w, y: METER.y + 34, w: 4, d: 12, r: 1 },
			8,
			8,
			s.P,
			2
		)
	);
}

function processor() {
	s.halo(CPU, 0);
	s.solid(slabOf(CPU, 0, CPU_H, s.P, 4, 0.8), { tone: "lo" });
	const deck = insetPlan(CPU, 5);
	s.solid(slabOf(deck, CPU_H, 3, s.P, 3, 0.5));
	// Heatsink fins standing across the deck.
	for (let i = 0; i < FINS; i++) {
		const x = deck.x + 3 + i * ((deck.w - 6) / (FINS - 1)) - 0.8;
		s.solid(
			slabOf(
				{ x, y: deck.y + 3, w: 1.6, d: deck.d - 6, r: 0.3 },
				CPU_H + 3,
				20,
				s.P,
				2
			),
			{
				tone: "mid",
				crease: "none",
			}
		);
	}
	screws(s, corners(CPU, 2.6), CPU_H, 1);
	s.line(planOutline(insetPlan(CPU, 2), CPU_H, s.P, 2), { tone: "faint" });
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 16, w: 120, d: 7, r: 1 });
s.wire(
	[METER.x + METER.w + 4, METER.y + 40, 12],
	[CPU.x, CPU.y + CPU.d - 10, 4],
	[
		[METER.x + METER.w + 10, METER.y + 40, 0.8],
		[METER.x + METER.w + 10, CPU.y + CPU.d - 10, 0.8],
	],
	{ flow: true }
);
meter();
processor();

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
