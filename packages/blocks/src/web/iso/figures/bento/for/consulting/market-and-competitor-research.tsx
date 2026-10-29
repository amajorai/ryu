import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Market and competitor research: a survey table. The market is a relief
 * model of pegs, one per player, standing at their size; a sighting scope on
 * a post surveys it, and the findings are filed in the memo stack in front.
 * The client's own peg is the lit one.
 */

const PLATE = { x: -96, y: -52, w: 192, d: 104, r: 8 };
const TRAY = { x: -84, y: -40, w: 104, d: 80, r: 4 };
const TRAY_H = 6;
const HEIGHTS = [
	[10, 22, 14, 8],
	[18, 30, 12, 20],
	[8, 14, 26, 10],
];
const SCOPE: [number, number] = [58, -18];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-46, -14, 36]]);

benchPlate(s, PLATE);
// Sighting scope on a post, behind and to the right of the table.
s.halo({ x: SCOPE[0] - 12, y: SCOPE[1] - 12, w: 24, d: 24, r: 12 }, 0);
s.solid(cylinder(SCOPE[0], SCOPE[1], 11, 0, 3, s.P, 36, 0.6), { tone: "lo" });
s.solid(cylinder(SCOPE[0], SCOPE[1], 2.6, 3, 24, s.P, 20));
s.solid(cylinder(SCOPE[0], SCOPE[1], 5, 27, 4, s.P, 24), { tone: "lo" });
s.solid(
	slabOf(
		{ x: SCOPE[0] - 22, y: SCOPE[1] - 4, w: 34, d: 8, r: 4 },
		31,
		8,
		s.P,
		6,
		0.6
	)
);
s.line(ring(SCOPE[0] + 8, SCOPE[1], 2.4, 39, s.P, 20), { tone: "mid" });
// The relief tray: one peg per player, sized to its share.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(TRAY, 4), TRAY_H, s.P, 4), { tone: "faint" });
const pegs: [number, number, number, boolean][] = [];
HEIGHTS.forEach((row, j) => {
	row.forEach((height, i) => {
		pegs.push([
			TRAY.x + 18 + i * 23,
			TRAY.y + 16 + j * 24,
			height,
			i === 1 && j === 1,
		]);
	});
});
for (const [x, y, height, lit] of byDepth(pegs, s)) {
	const peg = { x: x - 7, y: y - 7, w: 14, d: 14, r: 2 };
	s.solid(slabOf(peg, TRAY_H, height, s.P, 3, 0.6), lit ? { lit } : {});
}
s.line(
	lineOnTop(
		[TRAY.x + 6, TRAY.y + TRAY.d - 5],
		[TRAY.x + TRAY.w - 6, TRAY.y + TRAY.d - 5],
		TRAY_H,
		s.P
	),
	{ tone: "lo" }
);
knob(s, [TRAY.x + TRAY.w - 9, TRAY.y + 8], TRAY_H, 3.5, 4);
// Findings memo: a short stack of sheets under a clip.
const memo = { x: 38, y: 10, w: 44, d: 32, r: 2 };
s.halo(memo, 0);
for (let i = 0; i < 3; i++) {
	s.solid(slabOf(insetPlan(memo, 2 - i), i * 1.6, 1.6, s.P, 3), {
		crease: "none",
		tone: i === 2 ? "mid" : "lo",
	});
}
for (let i = 0; i < 4; i++) {
	const y = memo.y + 12 + i * 5;
	s.line(
		lineOnTop(
			[memo.x + 6, y],
			[memo.x + memo.w - 8 - (i % 2) * 10, y],
			4.8,
			s.P
		),
		{
			tone: i === 0 ? "mid" : "lo",
		}
	);
}
s.solid(
	slabOf(
		{ x: memo.x + 12, y: memo.y - 1, w: 20, d: 7, r: 1.5 },
		4.8,
		2.4,
		s.P,
		3
	),
	{
		tone: "lo",
	}
);
screws(s, [[memo.x + 22, memo.y + 2.5]], 7.2, 1.2);

export const drawing = cardDrawing(s);
