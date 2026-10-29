import {
	boxCorners,
	corners,
	dotGrid,
	insetPlan,
	slabOf,
} from "../../kit/iso-kit.ts";
import { benchPlate, faceRect, faceRules, screws } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Ryu Cloud: managed hosting that runs your agents. A server cabinet on a
 * raised floor: a column of rack units with status lights, one unit (the lit
 * part) slid out on its rails, and a smaller cabinet beside it.
 */

const WIDTH = 640;
const HEIGHT = 440;
const PLATE = { x: -130, y: -90, w: 250, d: 170, r: 8 };
const CAB = { x: -70, y: -76, w: 60, d: 62, r: 2 };
const CAB_H = 132;
const UNITS = 10;
const UNIT_H = (CAB_H - 20) / UNITS;
const PULLED = 6;
const PULL = 26;
const SIDE = { x: 6, y: -76, w: 44, d: 62, r: 2 };
const SIDE_H = 78;

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [CAB.x, CAB.y, CAB_H + 4]],
	WIDTH,
	HEIGHT
);
const unitZ = (index: number) => 8 + (UNITS - 1 - index) * UNIT_H;

function cabinet(
	plan: typeof CAB,
	height: number,
	units: number,
	pulled?: number
) {
	const face = plan.y + plan.d;
	s.halo(plan, 0, 7);
	s.solid(slabOf(insetPlan(plan, -1.5), 0, 5, s.P, 3, 0.6), { tone: "lo" });
	s.solid(slabOf(plan, 5, height - 5, s.P, 3, 1));
	screws(s, corners(plan, 4), height, 1.3);
	s.line(
		faceRect(s, "y", face, plan.x + 3, plan.x + plan.w - 3, 6, height - 4),
		{ tone: "mid" }
	);
	for (let i = 0; i < units; i++) {
		const z = 8 + (units - 1 - i) * ((height - 20) / units);
		if (i === pulled) {
			continue;
		}
		const h = (height - 20) / units - 1.4;
		s.line(faceRect(s, "y", face, plan.x + 6, plan.x + plan.w - 6, z, z + h));
		faceRules(s, "y", face, plan.x + 10, z + h / 2, [plan.w * 0.35], 0);
		s.dots(
			[0, 1, 2].map((k) =>
				s.at([plan.x + plan.w - 10 - k * 4, face, z + h / 2])
			),
			{ size: 0.55, tone: i % 3 === 0 ? "hi" : "mid" }
		);
	}
}

function pulledUnit() {
	const z = unitZ(PULLED);
	const unit = {
		x: CAB.x + 6,
		y: CAB.y + CAB.d - 50 + PULL,
		w: CAB.w - 12,
		d: 50,
		r: 1,
	};
	// Slide rails on both sides.
	for (const x of [unit.x - 1.6, unit.x + unit.w]) {
		s.solid(
			slabOf({ x, y: unit.y, w: 1.6, d: unit.d, r: 0.3 }, z + 1, 2, s.P, 2),
			{ tone: "lo", crease: "none" }
		);
	}
	s.solid(slabOf(unit, z, UNIT_H - 1.4, s.P, 3, 0.4), { lit: true });
	s.dots(dotGrid(unit.x + 6, unit.y + 6, 6, 5, 7, z + UNIT_H - 1.4, s.P), {
		size: 0.45,
		tone: "lo",
	});
	const front = unit.y + unit.d;
	s.line(
		faceRect(
			s,
			"y",
			front,
			unit.x + 3,
			unit.x + unit.w - 3,
			z + 1.5,
			z + UNIT_H - 3
		),
		{ tone: "mid" }
	);
}

benchPlate(s, PLATE);
// Raised-floor tile grid.
s.dots(dotGrid(PLATE.x + 20, PLATE.y + 20, 9, 6, 24, 0, s.P), {
	size: 0.5,
	tone: "faint",
});
cabinet(CAB, CAB_H, UNITS, PULLED);
pulledUnit();
cabinet(SIDE, SIDE_H, 5);

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
