import {
	boxCorners,
	cylinder,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, byDepth, faceRect } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Pack and share: a packing bench. The SDK's parts wait in a sorted tray at
 * the back; the finished plugin goes out as a taped carton, sealed with the
 * lit stamp that makes it an installable app. A tape roll lies ready.
 */

const PLATE = { x: -96, y: -50, w: 184, d: 102, r: 8 };
const TRAY = { x: -86, y: -42, w: 74, d: 56, r: 4 };
const TRAY_H = 7;
const BOX = { x: 14, y: -28, w: 62, d: 56, r: 2 };
const BOX_H = 40;
const TAPE_X = BOX.x + BOX.w / 2;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [45, 0, BOX_H + 4]]);

benchPlate(s, PLATE);
// Parts tray: four compartments of SDK parts.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 6, 0.8));
const cellW = (TRAY.w - 12) / 2;
const cellD = (TRAY.d - 12) / 2;
const cells = [0, 1, 2, 3].map((i) => ({
	x: TRAY.x + 4 + (i % 2) * (cellW + 4),
	y: TRAY.y + 4 + Math.floor(i / 2) * (cellD + 4),
	w: cellW,
	d: cellD,
	r: 2,
}));
for (const cell of cells) {
	s.line(planOutline(cell, TRAY_H, s.P, 3), { tone: "lo" });
}
const [a, b, c, d] = cells;
const parts: [number, number, "bolt" | "block" | "disc"][] = [];
if (a && b && c && d) {
	for (const [dx, dy] of [
		[9, 8],
		[20, 8],
		[9, 17],
		[20, 17],
	] as const) {
		parts.push([a.x + dx, a.y + dy, "bolt"]);
	}
	parts.push([b.x + 9, b.y + 12, "block"], [b.x + 22, b.y + 12, "block"]);
	parts.push([c.x + 15, c.y + 12, "disc"]);
	parts.push([d.x + 10, d.y + 8, "bolt"], [d.x + 22, d.y + 16, "bolt"]);
}
for (const [x, y, kind] of byDepth(parts, s, TRAY_H)) {
	if (kind === "bolt") {
		s.solid(cylinder(x, y, 2.6, TRAY_H, 2, s.P, 6), { tone: "lo" });
		s.solid(cylinder(x, y, 1.3, TRAY_H + 2, 4, s.P, 16));
	} else if (kind === "block") {
		s.solid(
			slabOf({ x: x - 4, y: y - 6, w: 8, d: 12, r: 1 }, TRAY_H, 5, s.P, 2, 0.3)
		);
	} else {
		s.solid(cylinder(x, y, 8, TRAY_H, 3, s.P, 32, 0.4));
		s.line(ring(x, y, 3, TRAY_H + 3, s.P, 20), { tone: "lo" });
	}
}
// The carton, flaps closed and taped down the middle.
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 3, 0.4));
s.line(lineOnTop([TAPE_X, BOX.y], [TAPE_X, BOX.y + BOX.d], BOX_H, s.P), {
	tone: "mid",
});
s.solid(
	slabOf(
		{ x: TAPE_X - 6, y: BOX.y, w: 12, d: BOX.d, r: 0 },
		BOX_H,
		0.6,
		s.P,
		1
	),
	{ tone: "lo", crease: "none" }
);
s.line(
	faceRect(s, "y", BOX.y + BOX.d, TAPE_X - 6, TAPE_X + 6, BOX_H - 14, BOX_H),
	{
		tone: "lo",
	}
);
s.line(faceRect(s, "x", BOX.x + BOX.w, BOX.y + 10, BOX.y + 32, 8, 22), {
	tone: "faint",
});
// The seal stamped on the lid.
s.solid(cylinder(BOX.x + 16, BOX.y + BOX.d - 16, 7, BOX_H, 1.6, s.P, 36, 0.4), {
	lit: true,
});
// Tape roll lying on the bench.
s.halo({ x: -42, y: 24, w: 24, d: 24, r: 12 }, 0);
s.solid(cylinder(-30, 36, 11, 0, 8, s.P, 40, 0.6));
s.solid(cylinder(-30, 36, 6, 8, 0.4, s.P, 32), { tone: "lo", crease: "none" });
s.line(ring(-30, 36, 8, 8, s.P, 32), { tone: "faint" });

export const drawing = cardDrawing(s);
