import {
	boxCorners,
	cylinder,
	extrude,
	insetPlan,
	onTop,
	type Plane,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Edge case discovery: a shape sorter. Every well-formed block has a hole
 * that fits; the odd, malformed star (the lit block) sits on the lid by the
 * holes it fits none of, the input the probe turned up.
 */

const PLATE = { x: -96, y: -52, w: 192, d: 104, r: 8 };
const BOX = { x: -50, y: -40, w: 74, d: 68, r: 5 };
const BOX_H = 30;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-14, -6, BOX_H + 12],
]);

const triangle = (cx: number, cy: number, r: number): Plane[] =>
	[0, 1, 2].map((i) => {
		const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
		return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
	});

const star = (cx: number, cy: number, outer: number, inner: number): Plane[] =>
	Array.from({ length: 10 }, (_, i) => {
		const a = (i * Math.PI) / 5;
		const r = i % 2 === 0 ? outer : inner;
		return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
	});

benchPlate(s, PLATE);
// A cube that already went through, waiting beside the box.
s.halo({ x: -84, y: 14, w: 18, d: 18, r: 2 }, 0);
s.solid(slabOf({ x: -84, y: 14, w: 18, d: 18, r: 2 }, 0, 14, s.P, 3, 0.6));
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BOX, 4), BOX_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[BOX.x + 8, BOX.y + 8],
		[BOX.x + BOX.w - 8, BOX.y + BOX.d - 8],
	],
	BOX_H,
	1.4
);
// Three holes: round, square and triangular.
s.line(ring(-30, -20, 9, BOX_H, s.P, 32), { tone: "mid" });
s.line(planOutline({ x: 0, y: -30, w: 16, d: 16, r: 1 }, BOX_H, s.P, 2), {
	tone: "mid",
});
s.line(onTop(triangle(4, 10, 10), BOX_H, s.P, true), { tone: "mid" });
// The malformed star on the lid, matching none of them.
s.solid(extrude(star(-26, 10, 11, 5), BOX_H, 6, s.P, { convex: false }), {
	lit: true,
});
// Blocks that fit, laid out in front.
s.halo({ x: 40, y: -30, w: 20, d: 20, r: 10 }, 0);
s.solid(cylinder(50, -20, 9, 0, 14, s.P, 32, 0.6));
s.halo({ x: 38, y: 4, w: 22, d: 22, r: 4 }, 0);
s.solid(extrude(triangle(49, 16, 10), 0, 12, s.P));
s.halo({ x: -40, y: 32, w: 60, d: 12, r: 3 }, 0);
s.solid(slabOf({ x: -40, y: 34, w: 60, d: 10, r: 2 }, 0, 4, s.P, 3), {
	tone: "lo",
});
s.solid(cylinder(-28, 39, 3.2, 4, 3, s.P, 20));
s.solid(cylinder(-16, 39, 3.2, 4, 3, s.P, 20));
s.solid(slabOf({ x: -6, y: 36, w: 6, d: 6, r: 0.5 }, 4, 3, s.P, 2));
s.solid(cylinder(10, 39, 3.2, 4, 3, s.P, 20));

export const drawing = cardDrawing(s);
