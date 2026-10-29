import {
	boxCorners,
	corners,
	cylinder,
	insetPlan,
	knurl,
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
 * Bot: hand off a task and it is carried to the right line of work. A
 * transfer table: the task, a lit cart, rides a sliding platform across the
 * pit from the input track to one of three output lanes, beside a dial gauge.
 */

const WIDTH = 640;
const HEIGHT = 420;
const PLATE = { x: -150, y: -84, w: 300, d: 168, r: 8 };
const GAUGE = 7;
const RAIL_H = 2.4;
const LANES = [-50, 0, 50];
const PIT = { x: -48, y: -76, w: 52, d: 152, r: 2 };
const PLATFORM_Y = LANES[0] ?? -50;
const PLATFORM = { x: -44, y: PLATFORM_Y - 15, w: 44, d: 30, r: 2 };
const DIAL: [number, number] = [96, 62];
const DIAL_R = 15;
const DIAL_Z = 18;

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [DIAL[0], DIAL[1], DIAL_Z + 6]],
	WIDTH,
	HEIGHT
);

/** A straight run of track along x: sleepers, two rails, chair dots. */
function track(from: number, to: number, y: number, z = 0) {
	for (let x = from + 3; x < to - 2; x += 9) {
		s.solid(slabOf({ x, y: y - 11, w: 4.5, d: 22, r: 0.6 }, z, 1.4, s.P, 2), {
			tone: "lo",
			crease: "none",
		});
	}
	for (const side of [-GAUGE, GAUGE]) {
		s.solid(
			slabOf(
				{ x: from, y: y + side - 1.2, w: to - from, d: 2.4, r: 0.6 },
				z + 1.4,
				RAIL_H,
				s.P,
				2,
				0.3
			)
		);
	}
	const chairs: [number, number][] = [];
	for (let x = from + 5; x < to - 2; x += 9) {
		chairs.push(
			s.at([x, y - GAUGE - 2.2, z + 1.4]),
			s.at([x, y + GAUGE + 2.2, z + 1.4])
		);
	}
	s.dots(chairs, { size: 0.4, tone: "lo" });
}

function bufferStop(x: number, y: number) {
	s.solid(slabOf({ x, y: y - 12, w: 6, d: 24, r: 1 }, 0, 12, s.P, 3, 0.5));
	s.solid(slabOf({ x: x - 3, y: y - 9, w: 3, d: 5, r: 1 }, 5, 4, s.P, 3));
	s.solid(slabOf({ x: x - 3, y: y + 4, w: 3, d: 5, r: 1 }, 5, 4, s.P, 3));
	s.dots([s.at([x + 3, y - 8, 12]), s.at([x + 3, y + 8, 12])], { size: 0.45 });
}

function pit() {
	s.line(planOutline(PIT, 0, s.P, 3), { tone: "mid" });
	s.line(planOutline(insetPlan(PIT, 3), 0, s.P, 3), { tone: "faint" });
	for (const x of [PIT.x + 8, PIT.x + PIT.w - 12]) {
		s.solid(
			slabOf(
				{ x, y: PIT.y + 4, w: 4, d: PIT.d - 8, r: 0.6 },
				0,
				1.6,
				s.P,
				2,
				0.3
			)
		);
	}
	ruler(
		s,
		{ x: PIT.x + PIT.w + 2, y: PIT.y + 6, w: 6, d: PIT.d - 12, r: 1 },
		0,
		"y"
	);
}

function platform() {
	s.halo(PLATFORM, 1.6, 4);
	s.solid(slabOf(PLATFORM, 1.6, 4, s.P, 4, 0.6));
	screws(s, corners(PLATFORM, 3), 5.6, 1.2);
	track(PLATFORM.x, PLATFORM.x + PLATFORM.w, PLATFORM_Y, 5.6);
	const lever: [number, number] = [
		PLATFORM.x + PLATFORM.w - 6,
		PLATFORM.y + PLATFORM.d + 4,
	];
	s.solid(
		slabOf(
			{ x: lever[0] - 2, y: PLATFORM.y + PLATFORM.d, w: 4, d: 4, r: 1 },
			2,
			3,
			s.P,
			2
		),
		{ crease: "none" }
	);
	knob(s, lever, 1.6, 3, 5);
}

function cart() {
	const z = 5.6 + 1.4 + RAIL_H;
	const body = { x: PLATFORM.x + 8, y: PLATFORM_Y - 9, w: 28, d: 18, r: 2 };
	for (const x of [body.x + 4, body.x + body.w - 8]) {
		s.solid(
			slabOf(
				{ x, y: PLATFORM_Y - GAUGE - 2, w: 4, d: GAUGE * 2 + 4, r: 1.6 },
				z - 1,
				4,
				s.P,
				4
			)
		);
	}
	s.solid(slabOf(body, z + 3, 10, s.P, 4, 0.8), { lit: true });
	s.line(planOutline(insetPlan(body, 3), z + 13, s.P, 3));
}

function dial() {
	const [x, y] = DIAL;
	const top = DIAL_Z + 5;
	const ticks = radialTicks(
		x,
		y,
		DIAL_R - 3,
		40,
		5,
		top,
		[1.2, 2.6],
		s.P,
		-Math.PI * 0.75,
		Math.PI * 1.5
	);
	const angle = -Math.PI * 0.75 + Math.PI * 1.5 * 0.62;
	s.solid(
		slabOf({ x: x - 8, y: y - 8, w: 16, d: 16, r: 2 }, 0, 4, s.P, 4, 0.5)
	);
	s.solid(cylinder(x, y, 3, 4, DIAL_Z - 4, s.P, 20), { crease: "none" });
	s.solid(cylinder(x, y, DIAL_R, DIAL_Z, 5, s.P, 64, 0.8), {
		tone: "hi",
		crease: "lo",
	});
	s.line(knurl(x, y, DIAL_R, top - 2.4, top, 72, s.P, 0.3));
	s.line(ring(x, y, DIAL_R - 2, top, s.P, 64));
	s.line(ticks.minor);
	s.line(ticks.major, { tone: "mid" });
	s.line(
		lineOnTop(
			[x, y],
			[x + Math.cos(angle) * (DIAL_R - 4), y + Math.sin(angle) * (DIAL_R - 4)],
			top + 0.2,
			s.P
		),
		{
			tone: "lit",
			free: "end",
		}
	);
}

benchPlate(s, PLATE);
track(-140, -50, 0);
bufferStop(-146, 0);
pit();
LANES.forEach((y, index) => {
	track(6, 128, y);
	bufferStop(128, y);
	lamp(s, [12, y + 18], 0, { lit: index === 0 });
});
platform();
cart();
dial();

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
