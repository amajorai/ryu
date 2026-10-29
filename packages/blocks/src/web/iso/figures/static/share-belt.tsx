import {
	boxCorners,
	corners,
	cylinder,
	lineOnTop,
	ring,
	slabOf,
} from "../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, ruler, screws } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Ryu Share: lend idle capacity without giving up your machine. Two machines
 * on one bench joined by a belt: the idle one's pulley (the lit part) turns
 * and drives its neighbour's.
 */

const WIDTH = 640;
const HEIGHT = 420;
const PLATE = { x: -140, y: -76, w: 270, d: 140, r: 8 };
const A = { x: -122, y: -50, w: 72, d: 62, r: 4 };
const B = { x: 42, y: -50, w: 72, d: 62, r: 4 };
const H = 30;
const PULLEY_R = 15;
const PA: [number, number] = [A.x + A.w / 2, A.y + A.d / 2];
const PB: [number, number] = [B.x + B.w / 2, B.y + B.d / 2];
const PULLEY_Z = H + 4;

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [A.x, A.y, H + 14]],
	WIDTH,
	HEIGHT
);

function machine(plan: typeof A, idle: boolean) {
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, H, s.P, 5, 1));
	screws(s, corners(plan, 4), H, 1.2);
	const face = plan.y + plan.d;
	s.line(faceRect(s, "y", face, plan.x + 8, plan.x + plan.w - 8, 6, H - 8), {
		tone: "mid",
	});
	for (let i = 0; i < 4; i++) {
		s.line(
			lineOnTop(
				[plan.x + 8, plan.y + 8 + i * 3],
				[plan.x + 24, plan.y + 8 + i * 3],
				H,
				s.P
			)
		);
	}
	lamp(s, [plan.x + plan.w - 9, plan.y + 9], H, { lit: idle });
}

function pulley([x, y]: [number, number], lit: boolean) {
	s.solid(cylinder(x, y, 5, H, PULLEY_Z - H, s.P, 24), { crease: "none" });
	s.solid(cylinder(x, y, PULLEY_R, PULLEY_Z, 6, s.P, 64, 0.6), {
		tone: lit ? "hi" : "mid",
		lit,
	});
	s.line(ring(x, y, PULLEY_R - 4, PULLEY_Z + 6, s.P, 48));
	s.line(ring(x, y, 3, PULLEY_Z + 6, s.P, 20), { tone: "mid" });
	for (let k = 0; k < 4; k++) {
		const a = (k * Math.PI) / 2 + 0.4;
		s.line(
			lineOnTop(
				[x + Math.cos(a) * 3.4, y + Math.sin(a) * 3.4],
				[
					x + Math.cos(a) * (PULLEY_R - 4.4),
					y + Math.sin(a) * (PULLEY_R - 4.4),
				],
				PULLEY_Z + 6,
				s.P
			)
		);
	}
}

function belt() {
	const z = PULLEY_Z + 3;
	// The two straight runs between the pulleys, tangent to both rims.
	for (const side of [-1, 1]) {
		s.line(
			lineOnTop(
				[PA[0], PA[1] + side * PULLEY_R],
				[PB[0], PB[1] + side * PULLEY_R],
				z,
				s.P
			),
			{
				tone: "hi",
				flow: side === 1,
			}
		);
	}
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 16, w: 140, d: 7, r: 1 });
machine(A, true);
machine(B, false);
pulley(PA, true);
pulley(PB, false);
belt();

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
