import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, knob, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Prompt versions kept: a record changer. Every earlier pressing of the
 * agent's instructions stays stacked on the spindle under the current one,
 * whose label is lit; the tone arm plays only the top disc.
 */

const PLATE = { x: -96, y: -56, w: 192, d: 112, r: 8 };
const BASE = { x: -75, y: -46, w: 150, d: 92, r: 6 };
const BASE_H = 12;
const C: [number, number] = [-13, 0];
const DISC_R = 38;
const DISC_H = 2.2;
const DISCS = 6;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [C[0], C[1], 50]]);

benchPlate(s, PLATE);
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BASE, 4), BASE_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[BASE.x + 8, BASE.y + 8],
		[BASE.x + BASE.w - 8, BASE.y + 8],
	],
	BASE_H,
	1.6
);
// Platter and the stack of kept versions.
s.solid(cylinder(C[0], C[1], DISC_R + 3, BASE_H, 4, s.P, 64, 0.6), {
	tone: "lo",
});
const platter = BASE_H + 4;
for (let i = 0; i < DISCS; i++) {
	const z = platter + i * DISC_H;
	s.solid(cylinder(C[0], C[1], DISC_R, z, DISC_H, s.P, 64), {
		crease: "none",
	});
}
const top = platter + DISCS * DISC_H;
s.line(ring(C[0], C[1], DISC_R - 6, top, s.P, 56), { tone: "faint" });
s.line(ring(C[0], C[1], DISC_R - 12, top, s.P, 56), { tone: "faint" });
s.solid(cylinder(C[0], C[1], 12, top, 0.6, s.P, 40), { lit: true });
// Spindle with its stacking cap.
s.solid(cylinder(C[0], C[1], 1.6, top + 0.6, 16, s.P, 16));
s.solid(cylinder(C[0], C[1], 3.4, top + 12, 3, s.P, 20), { tone: "lo" });
// Tone arm: pivot post at the back right, arm resting on the top disc.
const pivot: [number, number] = [55, -30];
s.solid(cylinder(pivot[0], pivot[1], 8, BASE_H, 3, s.P, 28), { tone: "lo" });
s.solid(cylinder(pivot[0], pivot[1], 4.5, BASE_H + 3, 14, s.P, 24));
const armZ = BASE_H + 17;
const head: [number, number] = [C[0] + 20, C[1] - 18];
s.solid(cylinder(pivot[0] + 6, pivot[1] - 4, 4, armZ - 2, 4, s.P, 20), {
	tone: "lo",
});
s.line(lineOnTop(pivot, head, armZ, s.P), { tone: "hi" });
s.line(lineOnTop([pivot[0] + 0.8, pivot[1] + 0.8], head, armZ, s.P), {
	tone: "mid",
});
s.solid(
	slabOf(
		{ x: head[0] - 5, y: head[1] - 3, w: 8, d: 6, r: 1 },
		top,
		armZ - top,
		s.P,
		3
	),
	{ tone: "lo" }
);
// Speed knob and the arm rest at the front right.
knob(s, [57, 26], BASE_H, 6, 5);
s.solid(cylinder(37, 30, 2.4, BASE_H, 8, s.P, 16), { tone: "lo" });

export const drawing = cardDrawing(s);
