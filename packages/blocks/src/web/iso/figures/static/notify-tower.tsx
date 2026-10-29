import {
	boxCorners,
	corners,
	cylinder,
	insetPlan,
	ring,
	sideArc,
	slabOf,
} from "../../kit/iso-kit.ts";
import { benchPlate, byDepth, jack, lamp, ruler, screws } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Ryu Notify: durable events and their delivery. A signal tower whose lit tier
 * marks the event, beside a dispatcher box that sends it down three lines to
 * receivers at the edge of the bench.
 */

const WIDTH = 640;
const HEIGHT = 440;
const PLATE = { x: -130, y: -84, w: 250, d: 168, r: 8 };
const TOWER: [number, number] = [-62, -22];
const TIER_H = 14;
const TIERS = 4;
const LIT_TIER = 2;
const POLE_TOP = 50;
const BOX = { x: -20, y: -34, w: 50, d: 36, r: 3 };
const BOX_H = 18;
const RECEIVERS: [number, number][] = [
	[84, -54],
	[90, 0],
	[78, 52],
];

const s = createSketch(
	[
		...boxCorners(PLATE, -15, 0),
		[TOWER[0], TOWER[1], POLE_TOP + TIERS * TIER_H + 10],
	],
	WIDTH,
	HEIGHT
);

function tower() {
	const [x, y] = TOWER;
	s.halo({ x: x - 18, y: y - 18, w: 36, d: 36, r: 18 }, 0);
	s.solid(cylinder(x, y, 18, 0, 5, s.P, 48, 0.8), { tone: "lo" });
	s.solid(cylinder(x, y, 12, 5, 4, s.P, 40, 0.6));
	screws(
		s,
		[0, 1, 2, 3].map((k) => [
			x + Math.cos(k * 1.57 + 0.78) * 15,
			y + Math.sin(k * 1.57 + 0.78) * 15,
		]),
		5,
		1.2
	);
	s.solid(cylinder(x, y, 3.2, 9, POLE_TOP - 9, s.P, 24), { crease: "none" });
	for (let tier = 0; tier < TIERS; tier++) {
		const z = POLE_TOP + tier * TIER_H;
		s.solid(cylinder(x, y, 11, z, 1.6, s.P, 40));
		const lit = tier === LIT_TIER;
		s.solid(cylinder(x, y, 10, z + 1.6, TIER_H - 1.6, s.P, 40, 0.4), {
			tone: lit ? "hi" : "lo",
			lit,
		});
		s.line(sideArc(x, y, 10, z + TIER_H / 2, s.P, 32), { tone: "faint" });
	}
	const cap = POLE_TOP + TIERS * TIER_H;
	s.solid(cylinder(x, y, 11, cap, 3, s.P, 40, 0.8));
	s.line(ring(x, y, 4, cap + 3, s.P, 20), { tone: "mid" });
}

function dispatcher() {
	s.halo(BOX, 0);
	s.solid(slabOf(BOX, 0, BOX_H, s.P, 4, 1));
	const top = insetPlan(BOX, 4);
	screws(s, corners(BOX, 3), BOX_H, 1.2);
	lamp(s, [top.x + 6, top.y + 6], BOX_H, { lit: true });
	for (const y of [top.y + 6, top.y + 14, top.y + 22]) {
		jack(s, [top.x + top.w - 4, y], BOX_H);
	}
}

function receiver([x, y]: [number, number], index: number) {
	const plan = { x: x - 10, y: y - 8, w: 20, d: 16, r: 2 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, 10, s.P, 3, 0.6));
	lamp(s, [x - 3, y], 10, { radius: 1.8 });
	s.dots([s.at([x + 5, y - 3, 10]), s.at([x + 5, y + 3, 10])], {
		size: 0.45,
		tone: index === 0 ? "hi" : "mid",
	});
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 16, w: 120, d: 7, r: 1 });
// Delivery lines laid on the bench, from the dispatcher's jacks to each receiver.
const top = insetPlan(BOX, 4);
RECEIVERS.forEach(([x, y], index) => {
	const fromY = top.y + 6 + index * 8;
	s.wire(
		[top.x + top.w - 4, fromY, BOX_H],
		[x - 10, y, 4],
		[
			[BOX.x + BOX.w + 6, fromY, 0.8],
			[BOX.x + BOX.w + 6, y, 0.8],
		],
		{
			tone: "mid",
			flow: index === 0,
		}
	);
});
for (const [, , draw] of byDepth<[number, number, () => void]>(
	[
		[TOWER[0], TOWER[1], tower],
		[BOX.x + BOX.w / 2, BOX.y + BOX.d / 2, dispatcher],
		...RECEIVERS.map((point, index): [number, number, () => void] => [
			point[0],
			point[1],
			() => receiver(point, index),
		]),
	],
	s
)) {
	draw();
}

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
