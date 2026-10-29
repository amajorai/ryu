import {
	boxCorners,
	cylinder,
	knurl,
	radialTicks,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Compliance reminders: a deadline wheel. Each pin in the dial is someone's
 * training or certification due date; the wheel turns toward the fixed
 * finger, and the pin that has reached it (the lit one) is due, so the bell
 * beside the wheel rings for that nudge.
 */

const PLATE = { x: -84, y: -60, w: 176, d: 116, r: 8 };
const C: [number, number] = [-18, 0];
const R = 44;
const Z = 10;
const BELL: [number, number] = [60, 24];
const PINS = [0, 1.2, 2.1, 2.8, 3.9, 4.6, 5.5];
const DUE = 0;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [C[0], C[1], 30]]);

const polar = (angle: number, radius: number): [number, number] => [
	C[0] + Math.sin(angle) * radius,
	C[1] - Math.cos(angle) * radius,
];

benchPlate(s, PLATE);
s.halo(
	{ x: C[0] - R - 4, y: C[1] - R - 4, w: 2 * R + 8, d: 2 * R + 8, r: R + 4 },
	0
);
// The finger's post behind the wheel.
const post = polar(0, R + 8);
s.solid(cylinder(post[0], post[1], 4, 0, Z + 9, s.P, 24));
s.solid(cylinder(C[0], C[1], R + 4, 0, 4, s.P, 64, 0.6), { tone: "lo" });
s.solid(cylinder(C[0], C[1], R, 4, Z - 4, s.P, 64, 0.8));
s.line(knurl(C[0], C[1], R, 4, Z, 72, s.P), { tone: "faint" });
const ticks = radialTicks(C[0], C[1], R - 2, 48, 4, Z, [3, 6], s.P);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
s.line(ring(C[0], C[1], R - 14, Z, s.P, 48), { tone: "faint" });
const pins = PINS.map((angle, index): [number, number, number] => [
	...polar(angle, R - 18),
	index,
]);
for (const [x, y, index] of byDepth(pins, s)) {
	s.solid(cylinder(x, y, 2.4, Z, 5, s.P, 20), {
		lit: index === DUE,
	});
}
// The finger reaches over the due pin; the hub the wheel turns on.
s.solid(
	slabOf({ x: post[0] - 2, y: post[1], w: 4, d: 26, r: 1 }, Z + 6, 3, s.P, 2),
	{ tone: "lo" }
);
s.solid(cylinder(C[0], C[1], 8, Z, 4, s.P, 32));
s.solid(cylinder(C[0], C[1], 4, Z + 4, 6, s.P, 24), { tone: "lo" });
// Bell on its stand at the front right.
const base = { x: BELL[0] - 16, y: BELL[1] - 16, w: 32, d: 32, r: 4 };
s.halo(base, 0);
s.solid(slabOf(base, 0, 5, s.P, 4, 0.6));
lamp(s, [base.x + base.w - 5, base.y + 5], 5, { radius: 1.6 });
s.solid(cylinder(BELL[0], BELL[1], 2, 5, 4, s.P, 16), { tone: "lo" });
s.solid(cylinder(BELL[0], BELL[1], 14, 9, 7, s.P, 36, 0.6));
s.solid(cylinder(BELL[0], BELL[1], 10, 16, 5, s.P, 32, 0.6));
s.solid(cylinder(BELL[0], BELL[1], 6, 21, 3, s.P, 24, 0.4));
s.solid(cylinder(BELL[0], BELL[1], 2.2, 24, 4, s.P, 16), { tone: "lo" });

export const drawing = cardDrawing(s);
