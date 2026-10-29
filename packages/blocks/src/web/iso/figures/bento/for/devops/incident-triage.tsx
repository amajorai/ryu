import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Incident triage: a timeline bench. Two rows of bars stand on a base, metrics
 * in the back row and log volume in the front, both in time order along it.
 * A cursor plate (the lit part) is slid to the spike where the two rows line
 * up, the likely cause; the alarm beacon that started it stands behind.
 */

const PLATE = { x: -104, y: -52, w: 208, d: 104, r: 8 };
const BASE = { x: -90, y: -30, w: 150, d: 56, r: 4 };
const BASE_H = 6;
const STEP = 13;
const FIRST_X = -80;
const METRICS = [7, 10, 8, 11, 14, 30, 20, 12, 9, 8];
const LOGS = [5, 6, 5, 7, 11, 25, 16, 8, 6, 5];
const SPIKE = 5;
const CURSOR_X = FIRST_X + SPIKE * STEP - 7;
const BEACON: [number, number] = [80, -30];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [CURSOR_X, 0, 44]]);

function bar(index: number, y: number, height: number) {
	const x = FIRST_X + index * STEP;
	const plan = { x: x - 4, y, w: 8, d: 11, r: 1 };
	s.solid(slabOf(plan, BASE_H, height, s.P, 3, 0.4), {
		tone: index === SPIKE ? "hi" : "mid",
	});
}

function rows(from: number, to: number) {
	for (let i = from; i < to; i++) {
		bar(i, BASE.y + 7, METRICS[i] ?? 6);
		bar(i, BASE.y + 32, LOGS[i] ?? 4);
	}
}

benchPlate(s, PLATE);
// Alarm beacon on its post, behind the bench.
s.halo({ x: BEACON[0] - 9, y: BEACON[1] - 9, w: 18, d: 18, r: 9 }, 0);
s.solid(cylinder(BEACON[0], BEACON[1], 9, 0, 3, s.P, 32, 0.6), { tone: "lo" });
s.solid(cylinder(BEACON[0], BEACON[1], 2.6, 3, 24, s.P, 20));
s.solid(cylinder(BEACON[0], BEACON[1], 7, 27, 3, s.P, 32), { tone: "lo" });
s.solid(cylinder(BEACON[0], BEACON[1], 5.5, 30, 9, s.P, 32, 1.2));
s.line(ring(BEACON[0], BEACON[1], 5.5, 34, s.P, 32), { tone: "lo" });
// The timeline base with its two rows.
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BASE, 4), BASE_H, s.P, 4), { tone: "faint" });
rows(0, SPIKE);
// Cursor plate standing across both rows, on a shoe that rides the base.
s.solid(
	slabOf(
		{ x: CURSOR_X - 4, y: BASE.y + 2, w: 8, d: 6, r: 1 },
		BASE_H,
		3,
		s.P,
		2
	),
	{ tone: "lo" }
);
s.solid(
	slabOf(
		{ x: CURSOR_X - 1.5, y: BASE.y + 4, w: 3, d: BASE.d - 8, r: 0.6 },
		BASE_H,
		34,
		s.P,
		2
	),
	{ lit: true }
);
rows(SPIKE, METRICS.length);
screws(
	s,
	[
		[BASE.x + 5, BASE.y + 5],
		[BASE.x + BASE.w - 5, BASE.y + BASE.d - 5],
	],
	BASE_H,
	1.4
);
// Scrub knob at the front of the bench.
knob(s, [78, 30], 0, 6, 6);

export const drawing = cardDrawing(s);
