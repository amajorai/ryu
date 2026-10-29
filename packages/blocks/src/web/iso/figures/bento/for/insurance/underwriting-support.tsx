import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	segment,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Underwriting support: a pan balance. The application's risk factors are the
 * stacked weights on the left pan; the appetite guideline is the single
 * weight on the right. The left pan sits lower, so the referral note in the
 * tray in front (the lit slip) has been drafted for review.
 */

const PLATE = { x: -100, y: -56, w: 200, d: 112, r: 8 };
const BASE = { x: -84, y: -42, w: 112, d: 56, r: 5 };
const BASE_H = 14;
const LEFT: [number, number] = [-58, -9];
const RIGHT: [number, number] = [2, -9];
const PAN_R = 18;
const LEFT_Z = BASE_H + 6;
const RIGHT_Z = BASE_H + 13;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-28, -40, 52]]);

benchPlate(s, PLATE);
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BASE, 4), BASE_H, s.P, 4), { tone: "faint" });
faceRules(s, "y", BASE.y + BASE.d, BASE.x + 10, 9, [26, 18], 4);
// Indicator plate standing at the back: the pointer leans toward the left.
const dial = { x: -44, y: -40, w: 32, d: 3, r: 0.5 };
s.solid(slabOf(dial, BASE_H, 32, s.P, 2));
const face = dial.y + dial.d;
for (let i = 0; i <= 6; i++) {
	const x = dial.x + 4 + i * 4;
	const long = i % 3 === 0;
	s.line(
		segment([x, face, BASE_H + 27], [x, face, BASE_H + (long ? 22 : 24)], s.P),
		{
			tone: long ? "mid" : "lo",
		}
	);
}
s.line(segment([-28, face, BASE_H + 6], [-36, face, BASE_H + 22], s.P), {
	tone: "hi",
});
// Left pan: lower, carrying the risk weights.
s.solid(cylinder(LEFT[0], LEFT[1], 3, BASE_H, LEFT_Z - BASE_H, s.P, 20), {
	tone: "lo",
});
s.solid(cylinder(LEFT[0], LEFT[1], PAN_R, LEFT_Z, 2.5, s.P, 48, 0.6));
s.line(ring(LEFT[0], LEFT[1], PAN_R - 3, LEFT_Z + 2.5, s.P, 48), {
	tone: "lo",
});
const weights: [number, number, number][] = [
	[LEFT[0] - 7, LEFT[1] - 6, 6],
	[LEFT[0] + 6, LEFT[1] - 4, 5],
	[LEFT[0] - 4, LEFT[1] + 7, 7],
];
for (const [x, y, r] of weights) {
	s.solid(cylinder(x, y, r, LEFT_Z + 2.5, r + 3, s.P, 28, 0.4));
	s.solid(cylinder(x, y, 1.6, LEFT_Z + r + 5.5, 2.5, s.P, 16), { tone: "lo" });
}
// Right pan: higher, one guideline weight.
s.solid(cylinder(RIGHT[0], RIGHT[1], 3, BASE_H, RIGHT_Z - BASE_H, s.P, 20), {
	tone: "lo",
});
s.solid(cylinder(RIGHT[0], RIGHT[1], PAN_R, RIGHT_Z, 2.5, s.P, 48, 0.6));
s.line(ring(RIGHT[0], RIGHT[1], PAN_R - 3, RIGHT_Z + 2.5, s.P, 48), {
	tone: "lo",
});
s.solid(cylinder(RIGHT[0], RIGHT[1], 8, RIGHT_Z + 2.5, 9, s.P, 32, 0.6));
s.solid(cylinder(RIGHT[0], RIGHT[1], 2, RIGHT_Z + 11.5, 3, s.P, 16), {
	tone: "lo",
});
screws(
	s,
	[
		[BASE.x + 7, BASE.y + 7],
		[BASE.x + BASE.w - 7, BASE.y + BASE.d - 7],
	],
	BASE_H,
	1.3
);
// Referral tray in front with the drafted note.
const tray = { x: 40, y: -16, w: 46, d: 56, r: 3 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 5, s.P, 4, 0.6), { tone: "lo" });
lamp(s, [tray.x + tray.w - 7, tray.y + 6], 5, { radius: 1.5 });
s.solid(
	slabOf({ x: tray.x + 6, y: tray.y + 12, w: 30, d: 38, r: 1 }, 5, 1.4, s.P, 2),
	{
		lit: true,
		crease: "none",
	}
);

export const drawing = cardDrawing(s);
