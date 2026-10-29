import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Sub-agent delegation: a fan-out line. A hopper feeds a distribution rail
 * that splits the work onto three short belts, each ending at a different
 * specialist station; a collecting rail gathers their output and one chute
 * drops the merged result (the lit block) into a single bin. A piece of
 * the split task rides each belt.
 */

const PLATE = { x: -100, y: -58, w: 200, d: 116, r: 8 };
const BELT_H = 6;
const STATION_H = 20;
const ROWS = [-34, -4, 26];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-74, 0, 40]]);

function station(y: number, index: number) {
	const plan = { x: -34, y: y - 10, w: 32, d: 20, r: 3 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, STATION_H, s.P, 6, 0.8));
	s.line(planOutline(insetPlan(plan, 3), STATION_H, s.P, 4), {
		tone: "faint",
	});
	// Each specialist carries a different tool on top.
	if (index === 0) {
		knob(s, [plan.x + 11, y], STATION_H, 4, 5);
	} else if (index === 1) {
		s.solid(cylinder(plan.x + 11, y, 5, STATION_H, 9, s.P, 28), {
			tone: "lo",
		});
		s.solid(cylinder(plan.x + 11, y, 3, STATION_H + 9, 3, s.P, 24));
	} else {
		s.solid(
			slabOf(
				{ x: plan.x + 5, y: y - 5, w: 13, d: 10, r: 1 },
				STATION_H,
				6,
				s.P,
				3
			),
			{ tone: "lo" }
		);
	}
	lamp(s, [plan.x + 25, y + 4], STATION_H, { radius: 1.6 });
}

benchPlate(s, PLATE);
// Hopper: a box with an open throat and a stack of incoming work.
const hopper = { x: -90, y: -16, w: 28, d: 32, r: 3 };
s.halo(hopper, 0);
s.solid(slabOf(hopper, 0, 26, s.P, 6, 0.8));
s.line(planOutline(insetPlan(hopper, 4), 26, s.P, 4), { tone: "mid" });
s.solid(slabOf({ x: -82, y: -8, w: 12, d: 16, r: 1 }, 26, 10, s.P, 3), {
	tone: "lo",
});
// Distribution rail across all three rows.
s.solid(
	slabOf({ x: -62, y: -46, w: 12, d: 84, r: 2 }, 0, BELT_H, s.P, 4, 0.4),
	{ tone: "lo" }
);
for (const y of ROWS) {
	const belt = { x: -50, y: y - 5, w: 16, d: 10, r: 1 };
	s.solid(slabOf(belt, 0, BELT_H, s.P, 3), { tone: "lo" });
	s.line(lineOnTop([-48, y], [-36, y], BELT_H, s.P), { tone: "faint" });
	// One piece of the split task riding each belt.
	s.solid(slabOf({ x: -46, y: y - 3, w: 6, d: 6, r: 1 }, BELT_H, 5, s.P, 2), {
		tone: "mid",
	});
}
ROWS.forEach((y, index) => station(y, index));
// Collecting rail and the single chute into the bin.
s.solid(slabOf({ x: -2, y: -46, w: 12, d: 84, r: 2 }, 0, BELT_H, s.P, 4, 0.4), {
	tone: "lo",
});
s.solid(slabOf({ x: 10, y: -6, w: 22, d: 12, r: 1 }, 0, BELT_H, s.P, 3), {
	tone: "lo",
});
const bin = { x: 32, y: -24, w: 52, d: 48, r: 4 };
s.halo(bin, 0);
s.solid(slabOf(bin, 0, 12, s.P, 6, 0.8));
s.line(planOutline(insetPlan(bin, 4), 12, s.P, 4), { tone: "mid" });
s.solid(slabOf({ x: 46, y: -10, w: 24, d: 20, r: 2 }, 12, 8, s.P, 4, 0.6), {
	lit: true,
});
screws(
	s,
	[
		[bin.x + 6, bin.y + bin.d - 6],
		[bin.x + bin.w - 6, bin.y + 6],
	],
	12,
	1.4
);

export const drawing = cardDrawing(s);
