import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
	topTicks,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Campaign planning: a planning board. The one-line goal stands in its card
 * holder (the lit card); across the board, three channel grooves run under a
 * day scale, each filled with blocks of planned work laid out on the calendar.
 */

const PLATE = { x: -102, y: -52, w: 204, d: 104, r: 8 };
const HOLDER = { x: -92, y: -26, w: 26, d: 44, r: 3 };
const HOLDER_H = 10;
const BOARD = { x: -56, y: -42, w: 146, d: 84, r: 4 };
const BOARD_H = 6;
const ROWS = [-22, 2, 26];
const PLANNED: [number, number][][] = [
	[
		[-44, 30],
		[-6, 18],
		[30, 40],
	],
	[
		[-34, 22],
		[-4, 44],
		[50, 24],
	],
	[
		[-44, 18],
		[-18, 28],
		[24, 20],
		[52, 26],
	],
];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[HOLDER.x + 13, HOLDER.y + 8, HOLDER_H + 26],
]);

benchPlate(s, PLATE);
// Goal holder: a block with a slot, the goal card standing in it.
s.halo(HOLDER, 0);
s.solid(slabOf(HOLDER, 0, HOLDER_H, s.P, 4, 0.8));
const slot = { x: HOLDER.x + 11, y: HOLDER.y + 5, w: 4, d: 30, r: 1 };
s.line(planOutline(slot, HOLDER_H, s.P, 2), { tone: "mid" });
s.solid(
	slabOf(
		{ x: slot.x + 1, y: slot.y + 2, w: 2, d: 26, r: 0.4 },
		HOLDER_H,
		24,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
knob(s, [HOLDER.x + 13, HOLDER.y + HOLDER.d - 6], HOLDER_H, 3.5, 4);
// Calendar board: day scale along the back, three channel grooves.
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BOARD, 3), BOARD_H, s.P, 4), { tone: "faint" });
const days = topTicks(
	BOARD.x + 12,
	BOARD.x + BOARD.w - 12,
	9,
	7,
	BOARD.y + 4,
	BOARD_H,
	[2.5, 5],
	s.P
);
s.line(days.minor, { tone: "lo" });
s.line(days.major, { tone: "mid" });
ROWS.forEach((rowY, row) => {
	s.line(
		planOutline(
			{ x: BOARD.x + 8, y: rowY - 8, w: BOARD.w - 16, d: 16, r: 2 },
			BOARD_H,
			s.P,
			2
		),
		{ tone: "lo" }
	);
	for (const [x, w] of PLANNED[row] ?? []) {
		s.solid(
			slabOf(
				{ x, y: rowY - 6, w, d: 12, r: 1.5 },
				BOARD_H,
				6 + row * 1.5,
				s.P,
				3,
				0.4
			),
			{ tone: row === 1 ? "lo" : "mid" }
		);
	}
});
screws(
	s,
	[
		[BOARD.x + BOARD.w - 6, BOARD.y + 5],
		[BOARD.x + BOARD.w - 6, BOARD.y + BOARD.d - 5],
	],
	BOARD_H,
	1.4
);

export const drawing = cardDrawing(s);
