import {
	boxCorners,
	cylinder,
	planOutline,
	radialTicks,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, byDepth, jack, knob, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Your schedule: a segment time switch. Each pin around the dial is an hour;
 * only the pins you push up (your published hours) switch the machine on to
 * share. The lit pin is the hour now passing the fixed pointer.
 */

const PLATE = { x: -74, y: -64, w: 148, d: 128, r: 8 };
const HOUSING = { x: -50, y: -50, w: 100, d: 100, r: 12 };
const HOUSING_H = 26;
const R = 40;
const DIAL_H = 8;
const TOP = HOUSING_H + DIAL_H;
const PINS = 24;
const POINTER = 9;
const ON = new Set([6, 7, 8, 9, 10, 11, 12, 13, 14]);

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, TOP + 14]]);

// The kit's angle convention: 0 points to -y.
const polar = (angle: number, radius: number): [number, number] => [
	Math.sin(angle) * radius,
	-Math.cos(angle) * radius,
];

benchPlate(s, PLATE);
s.halo(HOUSING, 0);
s.solid(slabOf(HOUSING, 0, HOUSING_H, s.P, 8, 1));
screws(
	s,
	[
		[HOUSING.x + 8, HOUSING.y + 8],
		[HOUSING.x + HOUSING.w - 8, HOUSING.y + 8],
		[HOUSING.x + 8, HOUSING.y + HOUSING.d - 8],
	],
	HOUSING_H,
	1.5
);
// The dial and its hour ticks.
s.solid(cylinder(0, 0, R, HOUSING_H, DIAL_H, s.P, 72, 0.8));
s.line(ring(0, 0, R - 3, TOP, s.P, 72), { tone: "faint" });
const ticks = radialTicks(0, 0, R - 9, PINS, 6, TOP, [2, 4], s.P);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });

type Item = [number, number, "hub" | "pin", number];
const items: Item[] = [[0, 0, "hub", -1]];
for (let index = 0; index < PINS; index++) {
	const [x, y] = polar((Math.PI * 2 * index) / PINS, R - 4);
	items.push([x, y, "pin", index]);
}
for (const [x, y, kind, index] of byDepth(items, s, TOP)) {
	if (kind === "hub") {
		knob(s, [0, 0], TOP, 9, 6);
	} else if (ON.has(index)) {
		s.solid(cylinder(x, y, 2.4, TOP, 6, s.P, 16), {
			lit: index === POINTER,
			tone: index === POINTER ? "hi" : "mid",
		});
	} else {
		s.line(ring(x, y, 2.4, TOP, s.P, 16), { tone: "lo" });
	}
}
// Fixed pointer post at the front corner, its tip just under the lit pin.
const [px, py] = polar((Math.PI * 2 * POINTER) / PINS, R + 6);
s.solid(cylinder(px, py, 3.2, HOUSING_H, 1.4, s.P, 20), { tone: "lo" });
s.solid(cylinder(px, py, 1.8, HOUSING_H + 1.4, DIAL_H + 2, s.P, 16));
// Manual override slide and a socket on the housing's right corner.
const slide = { x: 30, y: -44, w: 14, d: 6, r: 1.5 };
s.line(planOutline(slide, HOUSING_H, s.P, 3), { tone: "mid" });
s.solid(slabOf({ x: 31, y: -43, w: 5, d: 4, r: 1 }, HOUSING_H, 3, s.P, 2));
jack(s, [-38, 38], HOUSING_H);

export const drawing = cardDrawing(s);
