import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../kit/iso-kit.ts";
import { benchPlate, knob, ruler, screws } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Ryu SDK: compose agents, tools and workflows from typed parts. A printer's
 * type case of sorted pieces, and a composing stick where a line is being set,
 * one sort (the lit part) lifted above its place in the line.
 */

const WIDTH = 640;
const HEIGHT = 420;
const PLATE = { x: -140, y: -84, w: 260, d: 168, r: 8 };
const CASE = { x: -128, y: -74, w: 150, d: 96, r: 3 };
const CASE_H = 12;
const STICK = { x: -60, y: 36, w: 140, d: 18, r: 2 };
const STICK_Z = 0;
const SORT_W = 7;
const SORTS = 12;
const LIFTED = 8;

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [STICK.x, STICK.y, 40]],
	WIDTH,
	HEIGHT
);

function typeCase() {
	s.halo(CASE, 0, 6);
	s.solid(slabOf(CASE, 0, CASE_H, s.P, 4, 0.8));
	const inner = insetPlan(CASE, 4);
	s.line(planOutline(inner, CASE_H, s.P, 2), { tone: "mid" });
	// Compartments of uneven sizes, as a real case has.
	const columns = [0, 14, 28, 50, 64, 86, 100, 114, inner.w];
	for (const dx of columns.slice(1, -1)) {
		s.line(
			lineOnTop(
				[inner.x + dx, inner.y],
				[inner.x + dx, inner.y + inner.d],
				CASE_H,
				s.P
			)
		);
	}
	for (const dy of [22, 44, 66]) {
		s.line(
			lineOnTop(
				[inner.x, inner.y + dy],
				[inner.x + inner.w, inner.y + dy],
				CASE_H,
				s.P
			)
		);
	}
	// A few sorts left standing in compartments.
	for (const [cx, cy] of [
		[6, 6],
		[33, 28],
		[70, 6],
		[104, 50],
		[90, 72],
		[18, 72],
	]) {
		for (let k = 0; k < 3; k++) {
			s.solid(
				slabOf(
					{
						x: inner.x + (cx ?? 0) + k * 3.4,
						y: inner.y + (cy ?? 0),
						w: 3,
						d: 9,
						r: 0.4,
					},
					CASE_H - 6,
					6.8,
					s.P,
					2
				),
				{
					tone: "lo",
					crease: "none",
				}
			);
		}
	}
	screws(
		s,
		[
			[CASE.x + 3, CASE.y + 3],
			[CASE.x + CASE.w - 3, CASE.y + 3],
		],
		CASE_H,
		1.1
	);
}

function stick() {
	s.halo(STICK, STICK_Z, 5);
	s.solid(slabOf(STICK, STICK_Z, 3, s.P, 3, 0.5));
	// Back wall and the sliding knee that sets the measure.
	s.solid(
		slabOf(
			{ x: STICK.x, y: STICK.y, w: STICK.w, d: 3, r: 0.6 },
			STICK_Z + 3,
			12,
			s.P,
			2,
			0.3
		)
	);
	s.solid(
		slabOf(
			{ x: STICK.x, y: STICK.y, w: 4, d: STICK.d, r: 0.6 },
			STICK_Z + 3,
			12,
			s.P,
			2,
			0.3
		)
	);
	const kneeX = STICK.x + 8 + SORTS * SORT_W + 4;
	s.solid(
		slabOf(
			{ x: kneeX, y: STICK.y, w: 5, d: STICK.d, r: 0.8 },
			STICK_Z + 3,
			13,
			s.P,
			3,
			0.4
		)
	);
	knob(s, [kneeX + 2.5, STICK.y + STICK.d + 4], STICK_Z, 2.6, 4);
	for (let i = 0; i < SORTS; i++) {
		const plan = {
			x: STICK.x + 6 + i * SORT_W,
			y: STICK.y + 3.5,
			w: SORT_W - 0.6,
			d: 11,
			r: 0.4,
		};
		if (i === LIFTED) {
			s.line(planOutline(plan, STICK_Z + 3, s.P, 2), { tone: "faint" });
			continue;
		}
		s.solid(slabOf(plan, STICK_Z + 3, 14, s.P, 2, 0.3), { crease: "none" });
		s.line(
			lineOnTop(
				[plan.x + 1.4, plan.y + 3],
				[plan.x + plan.w - 1.4, plan.y + 3],
				STICK_Z + 17,
				s.P
			),
			{
				tone: "faint",
				free: true,
			}
		);
	}
}

function liftedSort() {
	const plan = {
		x: STICK.x + 6 + LIFTED * SORT_W,
		y: STICK.y + 3.5,
		w: SORT_W - 0.6,
		d: 11,
		r: 0.4,
	};
	s.halo(plan, STICK_Z + 3, 3);
	s.solid(slabOf(plan, STICK_Z + 26, 14, s.P, 2, 0.3), { lit: true });
}

benchPlate(s, PLATE);
ruler(s, { x: STICK.x, y: STICK.y + STICK.d + 12, w: 140, d: 7, r: 1 });
typeCase();
stick();
liftedSort();

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
