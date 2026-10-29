import { boxCorners, cylinder, sideArc, slabOf } from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	byDepth,
	faceRect,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Paid by usage: a metered payout box. A cable feeds verified usage in at the
 * back, the counter wheels on the front tally it, and the box pays out coins
 * over its lip (the lit coin) into the tray, a stack per tally.
 */

const PLATE = { x: -92, y: -50, w: 184, d: 100, r: 8 };
const BOX = { x: -70, y: -38, w: 62, d: 60, r: 5 };
const BOX_H = 44;
const FACE = BOX.y + BOX.d;
const RIGHT = BOX.x + BOX.w;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-58, -26, 56]]);

function stack(x: number, y: number, count: number, z = 0, lit = false) {
	const h = count * 2.4;
	s.solid(cylinder(x, y, 8, z, h, s.P, 32, 0.4), { lit, tone: "hi" });
	const seams: string[] = [];
	for (let i = 1; i < count; i++) {
		seams.push(sideArc(x, y, 8, z + i * 2.4, s.P));
	}
	if (seams.length > 0) {
		s.line(seams.join(""), { tone: "lo" });
	}
}

benchPlate(s, PLATE);
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 6, 1.2));
// Counter window with five number wheels on the front (+y) face.
s.line(faceRect(s, "y", FACE, BOX.x + 8, RIGHT - 8, 26, 38), { tone: "mid" });
const wheels: string[] = [];
const cell = (BOX.w - 16) / 5;
for (let i = 0; i < 5; i++) {
	const a0 = BOX.x + 9 + i * cell;
	wheels.push(faceRect(s, "y", FACE, a0, a0 + cell - 2, 27.5, 36.5));
}
s.line(wheels.join(""), { tone: "lo" });
// Cable gland at the back of the top, feeding usage in.
s.solid(cylinder(BOX.x + 12, BOX.y + 12, 4.5, BOX_H, 2, s.P, 20), {
	tone: "lo",
});
s.solid(cylinder(BOX.x + 12, BOX.y + 12, 2.6, BOX_H + 2, 5, s.P, 16));
lamp(s, [BOX.x + 30, BOX.y + 8], BOX_H);
screws(
	s,
	[
		[RIGHT - 9, BOX.y + 9],
		[RIGHT - 9, FACE - 9],
	],
	BOX_H,
	1.5
);
// Coin slot on the top.
s.solid(slabOf({ x: -50, y: -14, w: 22, d: 5, r: 1.5 }, BOX_H, 1, s.P, 3), {
	tone: "lo",
});
// Payout lip sticking out of the right (+x) face, coin on it.
const LIP = { x: RIGHT, y: -26, w: 22, d: 26, r: 2 };
s.solid(slabOf(LIP, 16, 3, s.P, 3, 0.4), { tone: "lo" });
s.solid(slabOf({ x: RIGHT - 1, y: -24, w: 4, d: 22, r: 1 }, 19, 6, s.P, 2));
stack(RIGHT + 13, -13, 1, 19, true);
// Tray of paid stacks in front.
const TRAY = { x: 14, y: -6, w: 66, d: 46, r: 4 };
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 5, s.P, 4, 0.6));
s.solid(slabOf({ x: 17, y: -3, w: 60, d: 40, r: 3 }, 4.9, 0.2, s.P, 3), {
	tone: "lo",
	crease: "none",
});
for (const [x, y, n] of byDepth(
	[
		[30, 8, 2],
		[50, 6, 4],
		[68, 10, 3],
		[34, 26, 5],
		[56, 26, 3],
	] as [number, number, number][],
	s,
	5
)) {
	stack(x, y, n, 5);
}

export const drawing = cardDrawing(s);
