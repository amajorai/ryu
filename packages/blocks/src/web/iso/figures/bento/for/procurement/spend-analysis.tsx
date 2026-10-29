import {
	boxCorners,
	cylinder,
	knurl,
	ring,
	sideArc,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Spend analysis: a coin sorter. Spend is sorted into
 * one tube per category, stacked to its total; the two equal stacks are a
 * duplicate vendor, and the coins saved by merging them wait in the cup in
 * front (the lit coin).
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const TRAY = { x: -84, y: -26, w: 136, d: 40, r: 5 };
const TRAY_H = 6;
const COIN = 2.6;
const R = 10;
const STACKS: [number, number][] = [
	[-66, 12],
	[-40, 7],
	[-14, 7],
	[12, 4],
	[38, 9],
];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-66, -6, 50]]);

benchPlate(s, PLATE);
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 6, 0.8));
screws(
	s,
	[
		[TRAY.x + 6, TRAY.y + 6],
		[TRAY.x + TRAY.w - 6, TRAY.y + TRAY.d - 6],
	],
	TRAY_H,
	1.4
);
for (const [x, , coins] of byDepth(
	STACKS.map(([x, n]) => [x, -6, n] as const),
	s,
	TRAY_H
)) {
	const height = coins * COIN;
	s.solid(cylinder(x, -6, R + 2, TRAY_H, 2, s.P, 32), { tone: "lo" });
	s.solid(cylinder(x, -6, R, TRAY_H + 2, height, s.P, 36, 0.4));
	const arcs: string[] = [];
	for (let i = 1; i < coins; i++) {
		arcs.push(sideArc(x, -6, R, TRAY_H + 2 + i * COIN, s.P));
	}
	s.line(arcs.join(""), { tone: "faint" });
	s.line(ring(x, -6, R - 3, TRAY_H + 2 + height, s.P, 32), { tone: "lo" });
}
// Crank beside the tray.
knob(s, [TRAY.x + TRAY.w + 14, -6], 0, 6, 8);
// The savings cup in front, holding the one coin pulled out.
const cup: [number, number] = [-20, 32];
s.halo({ x: cup[0] - 14, y: cup[1] - 14, w: 28, d: 28, r: 14 }, 0);
s.solid(cylinder(cup[0], cup[1], 14, 0, 6, s.P, 40, 0.6), { tone: "lo" });
s.line(ring(cup[0], cup[1], 11, 6, s.P, 40), { tone: "mid" });
s.solid(cylinder(cup[0], cup[1], R, 6, COIN, s.P, 36, 0.4), { lit: true });
s.line(knurl(cup[0], cup[1], R, 6, 6 + COIN, 36, s.P), { tone: "lo" });

export const drawing = cardDrawing(s);
