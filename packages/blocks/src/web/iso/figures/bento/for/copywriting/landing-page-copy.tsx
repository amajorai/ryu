import {
	boxCorners,
	dotGrid,
	lineOnTop,
	type Plan,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Landing page copy: a letterpress chase locked up as one page. A wide
 * headline slug across the top, three benefit slugs under it, and the call
 * to action slug (the lit part) at the bottom, wedged tight by the quoin key.
 */

const PLATE = { x: -100, y: -56, w: 200, d: 112, r: 8 };
const CHASE = { x: -76, y: -46, w: 116, d: 92, r: 3 };
const BED = 4;
const WALL = 6;
const RIM = 6;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, 16]]);

function slug(plan: Plan, height: number, rules: number[], lit = false) {
	s.solid(slabOf(plan, BED, height, s.P, 3, 0.4), { lit, tone: "mid" });
	rules.forEach((width, index) => {
		const y = plan.y + 5 + index * 5;
		s.line(
			lineOnTop([plan.x + 4, y], [plan.x + 4 + width, y], BED + height, s.P),
			{
				tone: index === 0 ? "mid" : "lo",
			}
		);
	});
}

benchPlate(s, PLATE);
s.halo(CHASE, 0);
s.solid(slabOf(CHASE, 0, BED, s.P, 4, 0.6), { tone: "lo" });
// Back and left rails of the frame.
s.solid(slabOf({ ...CHASE, d: RIM, r: 1 }, BED, WALL, s.P, 2));
s.solid(slabOf({ ...CHASE, w: RIM, r: 1 }, BED, WALL, s.P, 2));
const inner = CHASE.x + RIM + 4;
slug({ x: inner, y: -36, w: 96, d: 18, r: 1 }, 7, [74, 52]);
for (let i = 0; i < 3; i++) {
	slug({ x: inner + i * 33, y: -14, w: 30, d: 24, r: 1 }, 5, [22, 16, 20]);
}
slug({ x: inner + 26, y: 15, w: 44, d: 16, r: 1 }, 6, [30], true);
// Front and right rails, then the quoin that locks the form.
s.solid(
	slabOf(
		{ ...CHASE, y: CHASE.y + CHASE.d - RIM, d: RIM, r: 1 },
		BED,
		WALL,
		s.P,
		2
	)
);
s.solid(
	slabOf(
		{ ...CHASE, x: CHASE.x + CHASE.w - RIM, w: RIM, r: 1 },
		BED,
		WALL,
		s.P,
		2
	)
);
// Case of spare type beside the chase.
const tray = { x: 54, y: -44, w: 34, d: 40, r: 3 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 6, s.P, 4, 0.6));
s.dots(dotGrid(tray.x + 6, tray.y + 6, 5, 6, 5.5, 6, s.P), { size: 0.7 });
knob(s, [70, 22], 0, 7, 7);

export const drawing = cardDrawing(s);
