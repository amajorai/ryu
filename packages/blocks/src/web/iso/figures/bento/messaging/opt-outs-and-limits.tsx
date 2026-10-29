import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, knob, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Opt-outs and limits: a row of letterboxes, one per recipient. The one who
 * replied STOP has its slot shuttered (the lit plate), so nothing goes in.
 * The tally counter beside them is the send cap: it counts up to its stop.
 */

const PLATE = { x: -100, y: -46, w: 200, d: 92, r: 8 };
const BOX_W = 28;
const BOX_D = 30;
const BOX_H = 34;
const BOX_Y = -16;
const BOXES = [-84, -50, -16];
const COUNTER = { x: 34, y: -22, w: 50, d: 44, r: 5 };
const COUNTER_H = 18;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-50, -16, 42]]);

function letterbox(x: number, shut: boolean) {
	const plan = { x, y: BOX_Y, w: BOX_W, d: BOX_D, r: 3 };
	const front = BOX_Y + BOX_D;
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, BOX_H, s.P, 4, 0.8));
	s.solid(slabOf(insetPlan(plan, -2), BOX_H, 3, s.P, 4, 0.6), { tone: "lo" });
	s.line(faceRect(s, "y", front, x + 4, x + BOX_W - 4, 4, 14), {
		tone: "faint",
	});
	if (shut) {
		s.solid(
			slabOf(
				{ x: x + 3, y: front, w: BOX_W - 6, d: 2, r: 0.5 },
				19,
				10,
				s.P,
				2
			),
			{ lit: true, crease: "none" }
		);
	} else {
		s.line(faceRect(s, "y", front, x + 6, x + BOX_W - 6, 22, 25), {
			tone: "mid",
		});
		// The slot's rain hood, open above the slot.
		s.solid(
			slabOf(
				{ x: x + 5, y: front, w: BOX_W - 10, d: 2, r: 0.5 },
				26,
				1.6,
				s.P,
				2
			),
			{ tone: "lo", crease: "none" }
		);
	}
}

benchPlate(s, PLATE);
for (const [index, x] of BOXES.entries()) {
	letterbox(x, index === 1);
}
// The tally counter: a window of number wheels, a plunger and a reset knob.
s.halo(COUNTER, 0);
s.solid(slabOf(COUNTER, 0, COUNTER_H, s.P, 6, 0.8));
const window = { x: COUNTER.x + 8, y: COUNTER.y + 8, w: 30, d: 14, r: 1.5 };
s.solid(slabOf(window, COUNTER_H, 0.6, s.P, 2), { tone: "lo", crease: "none" });
for (let i = 0; i < 3; i++) {
	const wheel = { x: window.x + 3 + i * 9, y: window.y + 2, w: 6, d: 10, r: 1 };
	s.solid(slabOf(wheel, COUNTER_H + 0.6, 1.2, s.P, 2), { crease: "none" });
	s.line(
		lineOnTop(
			[wheel.x + 1.5, wheel.y + 5],
			[wheel.x + 4.5, wheel.y + 5],
			COUNTER_H + 1.8,
			s.P
		),
		{ tone: "mid" }
	);
}
s.line(planOutline(insetPlan(COUNTER, 3), COUNTER_H, s.P, 4), {
	tone: "faint",
});
knob(s, [COUNTER.x + 12, COUNTER.y + 33], COUNTER_H, 4, 4);
s.solid(cylinder(COUNTER.x + 36, COUNTER.y + 32, 6, COUNTER_H, 6, s.P, 28));
s.solid(
	cylinder(COUNTER.x + 36, COUNTER.y + 32, 7.5, COUNTER_H + 6, 3, s.P, 28, 0.6),
	{
		tone: "lo",
	}
);
screws(
	s,
	[
		[COUNTER.x + 44, COUNTER.y + 6],
		[COUNTER.x + 6, COUNTER.y + 40],
	],
	COUNTER_H,
	1.2
);

export const drawing = cardDrawing(s);
