import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	radialTicks,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Account health checks: a console with three meters on its top, one each
 * for usage, tickets and notes. It reads all three and prints one short slip
 * out of the slot in its front (the lit part): what changed.
 */

const PLATE = { x: -92, y: -54, w: 184, d: 108, r: 8 };
const BASE = { x: -66, y: -38, w: 132, d: 62, r: 5 };
const BASE_H = 18;
const DIAL_R = 15;
const DIAL_Y = -12;
const FRONT = BASE.y + BASE.d;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, BASE_H + 6]]);

const polar = (angle: number, radius: number): [number, number] => [
	Math.sin(angle) * radius,
	-Math.cos(angle) * radius,
];

function meter(x: number, reading: number) {
	const top = BASE_H + 3;
	s.solid(cylinder(x, DIAL_Y, DIAL_R + 2, BASE_H, 3, s.P, 48, 0.6));
	s.line(ring(x, DIAL_Y, DIAL_R - 1, top, s.P, 48), { tone: "faint" });
	const ticks = radialTicks(
		x,
		DIAL_Y,
		DIAL_R - 2,
		16,
		4,
		top,
		[2, 4],
		s.P,
		-Math.PI * 0.6,
		Math.PI * 1.2
	);
	s.line(ticks.minor, { tone: "lo" });
	s.line(ticks.major, { tone: "mid" });
	const [nx, ny] = polar(reading, DIAL_R - 4);
	s.line(lineOnTop([x, DIAL_Y], [x + nx, DIAL_Y + ny], top, s.P), {
		tone: "hi",
	});
	s.solid(cylinder(x, DIAL_Y, 2.4, top, 1.6, s.P, 20), { tone: "lo" });
}

benchPlate(s, PLATE);
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BASE, 4), BASE_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[BASE.x + 7, BASE.y + 7],
		[BASE.x + BASE.w - 7, BASE.y + 7],
	],
	BASE_H,
	1.4
);
meter(-40, -0.9);
meter(0, 0.3);
meter(40, 1.1);
knob(s, [BASE.x + BASE.w - 14, FRONT - 9], BASE_H, 4, 4);
// The printer slot on the front face, and the slip coming out of it.
s.line(faceRect(s, "y", FRONT, -22, 22, 6, 10), { tone: "mid" });
const slip = { x: -16, y: FRONT, w: 32, d: 22, r: 1 };
s.solid(slabOf(slip, 7, 0.8, s.P, 2), { lit: true, crease: "none" });
for (const [i, length] of [24, 18, 21].entries()) {
	const y = FRONT + 7 + i * 5;
	s.line(lineOnTop([slip.x + 4, y], [slip.x + 4 + length, y], 7.8, s.P), {
		tone: "lo",
	});
}

export const drawing = cardDrawing(s);
