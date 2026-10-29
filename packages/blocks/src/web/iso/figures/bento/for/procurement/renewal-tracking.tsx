import {
	boxCorners,
	cylinder,
	dotGrid,
	insetPlan,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Renewal tracking: a tear-off desk calendar beside a striking bell. The
 * month's sheet marks the notice deadline (the lit day); the bell rings before
 * that day so the renewal brief is ready in time.
 */

const PLATE = { x: -100, y: -52, w: 200, d: 104, r: 8 };
const BLOCK = { x: -80, y: -40, w: 100, d: 76, r: 4 };
const BLOCK_H = 8;
const SHEET = 1.4;
const SHEETS = 4;
const BELL: [number, number] = [56, 0];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [56, 0, 40]]);

benchPlate(s, PLATE);
s.halo(BLOCK, 0);
s.solid(slabOf(BLOCK, 0, BLOCK_H, s.P, 6, 0.8), { tone: "lo" });
const pad = insetPlan(BLOCK, 5);
for (let i = 0; i < SHEETS; i++) {
	s.solid(slabOf(pad, BLOCK_H + i * SHEET, SHEET, s.P, 2), {
		crease: "none",
		tone: i === SHEETS - 1 ? "hi" : "mid",
	});
}
const top = BLOCK_H + SHEETS * SHEET;
// Binding bar with its rings at the head of the pad.
s.solid(
	slabOf(
		{ x: pad.x + 4, y: pad.y + 2, w: pad.w - 8, d: 8, r: 2 },
		top,
		3,
		s.P,
		3
	),
	{
		tone: "lo",
	}
);
for (const [x] of byDepth(
	[0, 1, 2, 3, 4].map((i) => [pad.x + 14 + i * 15, pad.y + 6] as const),
	s,
	top + 3
)) {
	s.solid(cylinder(x, pad.y + 6, 2, top + 3, 3, s.P, 16));
}
// The month grid: seven days by four weeks, ruled under a header.
s.line(
	lineOnTop([pad.x + 8, pad.y + 18], [pad.x + pad.w - 8, pad.y + 18], top, s.P),
	{
		tone: "mid",
	}
);
const gap = 11;
const gx = pad.x + 12;
const gy = pad.y + 26;
s.dots(dotGrid(gx, gy, 7, 4, gap, top, s.P), { size: 0.7 });
s.solid(
	slabOf(
		{ x: gx + 5 * gap - 4, y: gy + 2 * gap - 4, w: 8, d: 8, r: 1.5 },
		top,
		1.2,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
// The bell: a turned base, a column, the dome and its striker.
s.halo({ x: BELL[0] - 18, y: BELL[1] - 18, w: 36, d: 36, r: 18 }, 0);
s.solid(cylinder(BELL[0], BELL[1], 18, 0, 4, s.P, 40, 0.6), { tone: "lo" });
s.solid(cylinder(BELL[0], BELL[1], 3, 4, 8, s.P, 20));
s.solid(cylinder(BELL[0], BELL[1], 15, 12, 6, s.P, 40, 0.8));
s.solid(cylinder(BELL[0], BELL[1], 12, 18, 6, s.P, 40, 0.6));
s.solid(cylinder(BELL[0], BELL[1], 8, 24, 5, s.P, 32, 0.6));
s.solid(cylinder(BELL[0], BELL[1], 2.6, 29, 6, s.P, 16), { tone: "lo" });
s.solid(cylinder(BELL[0], BELL[1], 4, 35, 3, s.P, 20));

export const drawing = cardDrawing(s);
