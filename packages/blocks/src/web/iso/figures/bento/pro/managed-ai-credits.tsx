import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	radialTicks,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, byDepth, faceRect, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Managed AI credits: a coin dispenser. Three columns of five tokens stand
 * ready on its deck, a month wheel beside it turns once a month to refill
 * them, and the token just paid out (the lit part) lies in the front tray.
 */

const PLATE = { x: -92, y: -54, w: 184, d: 108, r: 8 };
const BASE = { x: -66, y: -42, w: 86, d: 48, r: 4 };
const BASE_H = 14;
const COIN_R = 9;
const COIN_H = 3;
const COINS = 5;
const WHEEL: [number, number] = [52, -18];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-46, -18, BASE_H + COINS * COIN_H + 10],
]);

function column(x: number, y: number) {
	s.solid(cylinder(x, y, COIN_R + 2, BASE_H, 1.6, s.P, 32), { tone: "lo" });
	for (let i = 0; i < COINS; i++) {
		const z = BASE_H + 1.6 + i * COIN_H;
		s.solid(cylinder(x, y, COIN_R, z, COIN_H - 0.4, s.P, 36, 0.4));
	}
	const top = BASE_H + 1.6 + COINS * COIN_H - 0.4;
	s.line(ring(x, y, COIN_R - 3, top, s.P, 28), { tone: "lo" });
}

benchPlate(s, PLATE);
// Dispenser body with three token columns.
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BASE, 4), BASE_H, s.P, 4), { tone: "faint" });
const columns = byDepth(
	[
		[-46, -18],
		[-23, -18],
		[0, -18],
	] as [number, number][],
	s,
	BASE_H
);
// A guide post behind each column, drawn before any column stands in front.
for (const [x, y] of columns) {
	s.solid(cylinder(x - 7, y - 9, 1.4, BASE_H, COINS * COIN_H + 8, s.P, 12), {
		tone: "lo",
	});
}
for (const [x, y] of columns) {
	column(x, y);
}
// Pay-out slot on the front face.
const front = BASE.y + BASE.d;
s.line(faceRect(s, "y", front, -34, -10, 4, 7), { tone: "mid" });
// Month wheel: twelve marks, a pointer and a hub.
s.halo({ x: WHEEL[0] - 22, y: WHEEL[1] - 22, w: 44, d: 44, r: 22 }, 0);
s.solid(cylinder(WHEEL[0], WHEEL[1], 22, 0, 6, s.P, 48, 0.8));
const ticks = radialTicks(WHEEL[0], WHEEL[1], 19, 12, 3, 6, [3, 5], s.P);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
s.line(lineOnTop(WHEEL, [WHEEL[0] + 9, WHEEL[1] - 9], 8.5, s.P), {
	tone: "hi",
});
s.solid(cylinder(WHEEL[0], WHEEL[1], 4, 6, 2.5, s.P, 24), { tone: "lo" });
screws(
	s,
	[
		[BASE.x + 8, BASE.y + 8],
		[BASE.x + BASE.w - 8, BASE.y + 8],
	],
	BASE_H,
	1.4
);
// Front tray holding the token just paid out.
const tray = { x: -48, y: 14, w: 52, d: 28, r: 3 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 4, s.P, 4, 0.6), { tone: "lo" });
s.line(planOutline(insetPlan(tray, 3), 4, s.P, 3), { tone: "faint" });
s.solid(cylinder(-22, 28, COIN_R, 4, 2.6, s.P, 36, 0.4), { lit: true });

export const drawing = cardDrawing(s);
