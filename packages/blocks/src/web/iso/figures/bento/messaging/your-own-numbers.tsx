import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	lineOnTop,
	planOutline,
	radialTicks,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Your own numbers: a SIM caddy. A row of numbers stands in its slots; yours
 * is lifted out of the row (the lit card). Beside it, a thirty-day date wheel
 * turns the lease over from credits each month.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const CADDY = { x: -80, y: -32, w: 104, d: 60, r: 4 };
const CADDY_H = 12;
const CARDS = 6;
const WHEEL: [number, number] = [56, 0];
const WHEEL_R = 22;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-10, -26, 50]]);

benchPlate(s, PLATE);
s.halo(CADDY, 0);
s.solid(slabOf(CADDY, 0, CADDY_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(CADDY, 4), CADDY_H, s.P, 4), { tone: "faint" });
for (let i = 0; i < CARDS; i++) {
	const x = CADDY.x + 14 + i * 15;
	const slot = { x: x - 2.5, y: CADDY.y + 8, w: 5, d: 44, r: 1 };
	s.line(planOutline(slot, CADDY_H, s.P, 2), { tone: "lo" });
	const raised = i === 4;
	s.solid(
		slabOf(
			{ x: x - 1.4, y: slot.y + 3, w: 2.8, d: 38, r: 1.4 },
			CADDY_H,
			raised ? 34 : 22,
			s.P,
			3
		),
		{ lit: raised, tone: "mid" }
	);
}
lamp(s, [CADDY.x + CADDY.w - 8, CADDY.y + CADDY.d - 8], CADDY_H, {
	radius: 1.8,
});
// The renewal wheel: thirty days around its face, a pointer at today.
s.halo(
	{
		x: WHEEL[0] - WHEEL_R,
		y: -WHEEL_R,
		w: WHEEL_R * 2,
		d: WHEEL_R * 2,
		r: WHEEL_R,
	},
	0
);
s.solid(cylinder(WHEEL[0], WHEEL[1], WHEEL_R + 3, 0, 3, s.P, 48), {
	tone: "lo",
});
s.solid(cylinder(WHEEL[0], WHEEL[1], WHEEL_R, 3, 8, s.P, 48, 0.6));
s.line(knurl(WHEEL[0], WHEEL[1], WHEEL_R, 3, 11, 48, s.P), { tone: "faint" });
const ticks = radialTicks(
	WHEEL[0],
	WHEEL[1],
	WHEEL_R - 2,
	30,
	5,
	11,
	[3, 6],
	s.P
);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
s.line(ring(WHEEL[0], WHEEL[1], WHEEL_R - 10, 11, s.P, 32), { tone: "faint" });
s.line(lineOnTop(WHEEL, [WHEEL[0] + 8, WHEEL[1] - 8], 13, s.P), { tone: "hi" });
s.solid(cylinder(WHEEL[0], WHEEL[1], 3.5, 11, 2.5, s.P, 20), { tone: "lo" });
screws(
	s,
	[
		[CADDY.x + 6, CADDY.y + CADDY.d - 6],
		[CADDY.x + 6, CADDY.y + 6],
	],
	CADDY_H,
	1.4
);

export const drawing = cardDrawing(s);
