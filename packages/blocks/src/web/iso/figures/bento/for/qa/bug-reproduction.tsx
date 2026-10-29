import {
	boxCorners,
	cylinder,
	extrude,
	lineOnTop,
	type Plane,
	pathOf,
	ring,
	slabOf,
	towardViewer,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Bug reproduction: a specimen jar. The bug from a vague report has been
 * caught and pinned on a pedestal under glass (the lit bug), small and
 * contained, so anyone can lift the lid and watch it fail again.
 */

const PLATE = { x: -62, y: -46, w: 146, d: 92, r: 8 };
const JX = -14;
const JY = -4;
const R = 30;
const BASE_H = 6;
const GLASS_TOP = 54;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[JX, JY, GLASS_TOP + 12],
]);

const ellipse = (cx: number, cy: number, rx: number, ry: number): Plane[] =>
	Array.from({ length: 24 }, (_, i) => {
		const a = (i * Math.PI * 2) / 24;
		return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
	});

benchPlate(s, PLATE);
// Jar base and the pedestal inside.
s.halo(
	{ x: JX - R - 4, y: JY - R - 4, w: 2 * R + 8, d: 2 * R + 8, r: R + 4 },
	0
);
s.solid(cylinder(JX, JY, R + 4, 0, BASE_H, s.P, 48, 0.8));
s.line(ring(JX, JY, R, BASE_H, s.P, 48), { tone: "lo" });
s.solid(cylinder(JX, JY, 10, BASE_H, 4, s.P, 32), { tone: "lo" });
s.solid(cylinder(JX, JY, 3, BASE_H + 4, 12, s.P, 16));
const deck = BASE_H + 16;
s.solid(cylinder(JX, JY, 12, deck, 2, s.P, 32, 0.4));
// The bug: legs on the deck, then its body and head.
const top = deck + 2;
for (const [dx, dy] of [
	[-5, -8],
	[0, -9],
	[5, -8],
	[-5, 8],
	[0, 9],
	[5, 8],
] as const) {
	s.line(
		lineOnTop([JX + dx * 0.4, JY + dy * 0.3], [JX + dx, JY + dy], top, s.P),
		{
			tone: "mid",
		}
	);
}
s.solid(extrude(ellipse(JX - 1, JY, 6.5, 4.5), top, 3.5, s.P), { lit: true });
s.solid(cylinder(JX + 7, JY, 2.4, top, 3, s.P, 16), { lit: true });
// The glass: rings at foot and rim, and its two silhouette edges.
const [vx, vy] = towardViewer(s.P);
const length = Math.hypot(vx, vy) || 1;
const [sx, sy] = [(-vy / length) * R, (vx / length) * R];
s.line(ring(JX, JY, R, GLASS_TOP, s.P, 48), { tone: "mid" });
for (const side of [-1, 1]) {
	s.line(
		pathOf([
			s.at([JX + side * sx, JY + side * sy, BASE_H]),
			s.at([JX + side * sx, JY + side * sy, GLASS_TOP]),
		]),
		{ tone: "mid" }
	);
}
// Lid and its handle.
s.solid(cylinder(JX, JY, R + 3, GLASS_TOP, 5, s.P, 48, 0.8));
s.solid(cylinder(JX, JY, 6, GLASS_TOP + 5, 3, s.P, 24), { tone: "lo" });
s.solid(cylinder(JX, JY, 4, GLASS_TOP + 8, 3, s.P, 24));
// A small control strip in front of the jar.
const strip = { x: 34, y: 14, w: 40, d: 24, r: 3 };
s.halo(strip, 0);
s.solid(slabOf(strip, 0, 6, s.P, 4, 0.6));
knob(s, [46, 26], 6, 5, 5);
lamp(s, [64, 22], 6, { radius: 1.8 });
lamp(s, [64, 30], 6, { radius: 1.8 });

export const drawing = cardDrawing(s);
