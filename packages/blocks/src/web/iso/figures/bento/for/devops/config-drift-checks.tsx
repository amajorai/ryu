import {
	boxCorners,
	cylinder,
	lineOnTop,
	radialTicks,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, ruler, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Config drift checks: gauge blocks set against a straight fence, the
 * committed line. One block has crept off the fence (the lit block); the dial
 * indicator in front rests on it and reads how far it has drifted.
 */

const PLATE = { x: -98, y: -52, w: 196, d: 104, r: 8 };
const FENCE = { x: -84, y: -40, w: 160, d: 10, r: 2 };
const FENCE_H = 18;
const BLOCK = { w: 18, d: 16 };
const BLOCK_H = 12;
const XS = [-64, -40, -16, 8, 32, 56];
const DRIFTED = 8;
const DRIFT = 16;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-80, -40, FENCE_H + 4],
]);

function block(x: number, y: number, lit = false) {
	const plan = { x: x - BLOCK.w / 2, y, w: BLOCK.w, d: BLOCK.d, r: 1.5 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, BLOCK_H, s.P, 3, 0.6), { lit });
}

benchPlate(s, PLATE);
s.halo(FENCE, 0);
s.solid(slabOf(FENCE, 0, FENCE_H, s.P, 4, 0.8));
screws(
	s,
	[
		[FENCE.x + 6, FENCE.y + 5],
		[FENCE.x + FENCE.w - 6, FENCE.y + 5],
	],
	FENCE_H,
	1.4
);
const flush = FENCE.y + FENCE.d;
for (const x of XS) {
	if (x !== DRIFTED) {
		block(x, flush);
	}
}
block(DRIFTED, flush + DRIFT, true);
// Dial indicator on its base, its stem touching the drifted block.
const touch = flush + DRIFT + BLOCK.d;
const DIAL: [number, number] = [DRIFTED, touch + 16];
s.solid(
	slabOf({ x: DIAL[0] - 1, y: touch, w: 2, d: 8, r: 0.5 }, 6, 2, s.P, 2),
	{ tone: "lo" }
);
const base = { x: DIAL[0] - 12, y: DIAL[1] - 8, w: 24, d: 20, r: 3 };
s.halo(base, 0);
s.solid(slabOf(base, 0, 4, s.P, 4, 0.6), { tone: "lo" });
s.solid(cylinder(DIAL[0], DIAL[1], 9, 4, 6, s.P, 40, 0.8));
const ticks = radialTicks(DIAL[0], DIAL[1], 8, 30, 5, 10, [1.6, 3], s.P);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
s.line(lineOnTop(DIAL, [DIAL[0] + 5, DIAL[1] - 4], 10, s.P), { tone: "hi" });
s.solid(cylinder(DIAL[0], DIAL[1], 1.4, 10, 1, s.P, 12), { tone: "lo" });
// A steel rule along the front edge.
ruler(s, { x: -84, y: 34, w: 64, d: 8, r: 1 });

export const drawing = cardDrawing(s);
