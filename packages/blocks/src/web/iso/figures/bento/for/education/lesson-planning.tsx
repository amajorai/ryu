import {
	boxCorners,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	byDepth,
	knob,
	ruler,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Lesson planning: a planning board with three grooved lanes (objectives,
 * activities, wrap-up). Blocks sized by their minutes sit along a timing
 * ruler; the lit block is the activity just placed, and the kitchen timer
 * beside the board keeps the period honest.
 */

const PLATE = { x: -104, y: -50, w: 208, d: 100, r: 8 };
const BOARD = { x: -92, y: -40, w: 150, d: 76, r: 4 };
const BOARD_H = 6;
const LANES = [-30, -14, 2];
const LANE_D = 12;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [80, -10, 16]]);

benchPlate(s, PLATE);
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 6, 0.8));
for (const y of LANES) {
	s.line(
		planOutline(
			{ x: BOARD.x + 6, y: y - LANE_D / 2, w: BOARD.w - 12, d: LANE_D, r: 1 },
			BOARD_H,
			s.P,
			2
		),
		{ tone: "faint" }
	);
}
// Blocks: [x start, width, lane], their width standing for minutes.
const blocks: [number, number, number, boolean][] = [
	[-84, 30, 0, false],
	[-84, 18, 1, false],
	[-62, 40, 1, true],
	[-18, 26, 1, false],
	[-84, 22, 2, false],
	[-58, 16, 2, false],
	[-6, 34, 0, false],
];
const placed = byDepth(
	blocks.map(([x, w, lane, lit]) => [
		x + w / 2,
		LANES[lane] ?? 0,
		x,
		w,
		lit,
	]) as [number, number, number, number, boolean][],
	s,
	BOARD_H
);
for (const [, y, x, w, lit] of placed) {
	const plan = {
		x: x + 1,
		y: y - LANE_D / 2 + 2,
		w: w - 2,
		d: LANE_D - 4,
		r: 1.5,
	};
	s.solid(slabOf(plan, BOARD_H, lit ? 7 : 5, s.P, 3, 0.4), { lit });
}
ruler(s, { x: BOARD.x + 6, y: 20, w: BOARD.w - 12, d: 9, r: 1 }, BOARD_H);
s.line(lineOnTop([BOARD.x + 6, 32], [BOARD.x + 60, 32], BOARD_H, s.P), {
	tone: "lo",
});
screws(
	s,
	[
		[BOARD.x + BOARD.w - 8, BOARD.y + 6],
		[BOARD.x + BOARD.w - 8, 32],
	],
	BOARD_H,
	1.4
);
// Kitchen timer: a wide knurled dial on the plate.
s.halo({ x: 66, y: -24, w: 28, d: 28, r: 14 }, 0);
knob(s, [80, -10], 0, 13, 12);

export const drawing = cardDrawing(s);
