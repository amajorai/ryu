import {
	boxCorners,
	corners,
	cylinder,
	dotGrid,
	insetPlan,
	lineOnTop,
	type Plan,
	type Point3,
	planOutline,
	slabOf,
} from "../../kit/iso-kit.ts";
import { byDepth, jack, knob, lamp, screws } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Extensions: plugins snap into one host. A modular synth case: modules of
 * different widths on the case rails, patched together; one module (the lit
 * part) lifted out above its empty slot.
 */

const WIDTH = 640;
const HEIGHT = 420;
const CASE = { x: -128, y: -62, w: 256, d: 124, r: 6 };
const FLOOR_H = 8;
const WALL = 5;
const TOP = 20;
const MODULE_H = TOP - FLOOR_H - 1;
const LIFT = 28;
const RAIL_D = 8;
const SPAN = { y: CASE.y + WALL + 2, d: CASE.d - (WALL + 2) * 2 };
const WIDTHS = [34, 26, 46, 30, 42, 36];
const LIFTED = 4;

const s = createSketch(
	[...boxCorners(CASE, -6, TOP), [0, 0, TOP + LIFT + 8]],
	WIDTH,
	HEIGHT,
	{ pad: 28 }
);

const modules: Plan[] = (() => {
	let x = CASE.x + WALL + 3;
	return WIDTHS.map((w) => {
		const plan = { x, y: SPAN.y, w, d: SPAN.d, r: 1.4 };
		x += w + 1.5;
		return plan;
	});
})();

const wall = (plan: Plan) =>
	s.solid(slabOf(plan, FLOOR_H, TOP - FLOOR_H, s.P, 3, 0.6));

function moduleAt(plan: Plan, index: number, z: number, lit = false) {
	const top = z + MODULE_H;
	const cx = plan.x + plan.w / 2;
	s.solid(slabOf(plan, z, MODULE_H, s.P, 3, 0.5), {
		tone: lit ? "hi" : "mid",
		lit,
		crease: "lo",
	});
	screws(
		s,
		[
			[plan.x + 3.5, plan.y + 4],
			[plan.x + plan.w - 3.5, plan.y + plan.d - 4],
		],
		top,
		1.2
	);
	const rows = plan.w > 40 ? [cx - 10, cx + 10] : [cx];
	rows.forEach((x, row) => {
		knob(s, [x, plan.y + 22], top, plan.w > 30 ? 5.5 : 4, 4);
		knob(s, [x, plan.y + 44], top, 3.4, 3.5);
		if (index % 2 === row % 2) {
			lamp(s, [x, plan.y + 60], top, { lit });
		} else {
			s.line(
				planOutline(
					{ x: x - 1.2, y: plan.y + 54, w: 2.4, d: 22, r: 1.2 },
					top,
					s.P,
					3
				)
			);
			s.solid(
				slabOf(
					{ x: x - 2.6, y: plan.y + 60, w: 5.2, d: 4, r: 0.8 },
					top,
					2.2,
					s.P,
					2
				)
			);
		}
	});
	for (const x of rows.length > 1 ? [cx - 10, cx, cx + 10] : [cx - 6, cx + 6]) {
		jack(s, [x, plan.y + plan.d - 14], top);
	}
	s.line(
		lineOnTop(
			[plan.x + 3, plan.y + 8],
			[plan.x + plan.w - 3, plan.y + 8],
			top,
			s.P
		),
		{ tone: "faint" }
	);
}

/** A patch cable that leaves one jack, sags and lands on another. */
function patch(
	from: number,
	fromX: number,
	to: number,
	toX: number,
	sag: number
) {
	const z = TOP - 1;
	const jackY = (index: number) => {
		const plan = modules[index];
		return plan ? plan.y + plan.d - 14 : 0;
	};
	const a: Point3 = [fromX, jackY(from), z];
	const b: Point3 = [toX, jackY(to), z];
	const via: Point3[] = [];
	for (let i = 1; i < 12; i++) {
		const t = i / 12;
		via.push([
			a[0] + (b[0] - a[0]) * t,
			a[1] + 10 * Math.sin(Math.PI * t),
			z + sag * Math.sin(Math.PI * t),
		]);
	}
	s.wire(a, b, via, { tone: "hi" });
}

const centre = (index: number) => {
	const plan = modules[index];
	return plan ? plan.x + plan.w / 2 : 0;
};

s.halo(CASE, -6, 9);
for (const [x, y] of byDepth(corners(CASE, 16), s)) {
	s.solid(cylinder(x, y, 5, -6, 6, s.P, 24), { tone: "lo" });
}
s.solid(slabOf(CASE, 0, FLOOR_H, s.P, 8, 1.2));
wall({ x: CASE.x, y: CASE.y, w: CASE.w, d: WALL, r: 2 });
wall({ x: CASE.x, y: CASE.y, w: WALL, d: CASE.d, r: 2 });
for (const y of [SPAN.y, SPAN.y + SPAN.d - RAIL_D]) {
	const rail = { x: CASE.x + WALL, y, w: CASE.w - WALL * 2, d: RAIL_D, r: 0.8 };
	s.solid(slabOf(rail, FLOOR_H, 2, s.P, 2, 0.3), { tone: "lo" });
}
const slot = modules[LIFTED];
if (slot) {
	s.line(planOutline(insetPlan(slot, 2), FLOOR_H + 0.1, s.P, 3));
	s.dots(dotGrid(slot.x + 8, slot.y + 20, 4, 9, 8, FLOOR_H, s.P), {
		size: 0.4,
		tone: "lo",
	});
}
modules.forEach((plan, index) => {
	if (index !== LIFTED) {
		moduleAt(plan, index, FLOOR_H);
	}
});
wall({ x: CASE.x + CASE.w - WALL, y: CASE.y, w: WALL, d: CASE.d, r: 2 });
wall({ x: CASE.x, y: CASE.y + CASE.d - WALL, w: CASE.w, d: WALL, r: 2 });
screws(s, corners(CASE, 2.5), TOP, 1.3);
patch(0, centre(0) - 6, 2, centre(2) + 10, 12);
patch(1, centre(1), 3, centre(3) + 6, 16);
if (slot) {
	s.halo(slot, FLOOR_H, 6);
	moduleAt(slot, LIFTED, FLOOR_H + LIFT, true);
}

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
