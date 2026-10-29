import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Calendar management: a planning board with a column per day. Meetings are
 * tiles seated in the columns; one tile has been lifted out of a clash and
 * reseated in a free slot (the lit tile), its old place left as an outline.
 */

const PLATE = { x: -100, y: -58, w: 200, d: 116, r: 8 };
const BOARD = { x: -86, y: -44, w: 160, d: 92, r: 4 };
const BOARD_H = 6;
const HEADER = { x: BOARD.x + 4, y: BOARD.y + 4, w: BOARD.w - 8, d: 12, r: 2 };
const COL_W = 30;
const COL_X0 = BOARD.x + 6;
const ROW_Y0 = HEADER.y + HEADER.d + 4;
const ROW_Y1 = BOARD.y + BOARD.d - 6;
const TILE_H = 4;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, 20]]);

const colX = (col: number) => COL_X0 + col * COL_W;

/** Meetings as [column, start y, length]; the lit one is the rescheduled tile. */
const TILES: [number, number, number, boolean][] = [
	[0, ROW_Y0 + 6, 16, false],
	[0, ROW_Y0 + 40, 22, false],
	[1, ROW_Y0 + 14, 28, false],
	[2, ROW_Y0 + 2, 12, false],
	[3, ROW_Y0 + 46, 16, true],
	[3, ROW_Y0 + 24, 14, false],
	[4, ROW_Y0 + 10, 30, false],
];

benchPlate(s, PLATE);
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 4, 0.8));
s.line(planOutline(insetPlan(BOARD, 2), BOARD_H, s.P, 3), { tone: "faint" });
// Column dividers and hour ticks.
for (let col = 1; col < 5; col++) {
	s.line(
		lineOnTop([colX(col) - 1, ROW_Y0], [colX(col) - 1, ROW_Y1], BOARD_H, s.P),
		{
			tone: "lo",
		}
	);
}
for (let y = ROW_Y0 + 8; y < ROW_Y1; y += 8) {
	s.line(lineOnTop([BOARD.x + 2, y], [BOARD.x + 5, y], BOARD_H, s.P), {
		tone: "faint",
	});
}
// Day header with one lamp per column.
s.solid(slabOf(HEADER, BOARD_H, 4, s.P, 3, 0.4), { tone: "lo" });
for (let col = 0; col < 5; col++) {
	lamp(s, [colX(col) + COL_W / 2 - 1, HEADER.y + 6], BOARD_H + 4, {
		radius: 1.6,
	});
}
// Where the clashing meeting sat before it moved.
s.line(
	planOutline(
		{ x: colX(3) + 3, y: ROW_Y0 + 6, w: COL_W - 8, d: 14, r: 1.5 },
		BOARD_H,
		s.P,
		2
	),
	{ tone: "lo", dotted: true }
);
for (const [col, y, length, lit] of byDepth(
	TILES.map(
		([col, y, length, lit]) =>
			[colX(col) + COL_W / 2, y + length / 2, col, length, lit] as const
	),
	s
).map(
	([, cy, col, length, lit]) => [col, cy - length / 2, length, lit] as const
)) {
	const tile = { x: colX(col) + 3, y, w: COL_W - 8, d: length, r: 1.5 };
	s.solid(slabOf(tile, BOARD_H, TILE_H + (lit ? 2 : 0), s.P, 2, 0.4), { lit });
}
screws(
	s,
	[
		[BOARD.x + BOARD.w - 5, BOARD.y + BOARD.d - 5],
		[BOARD.x + 5, BOARD.y + BOARD.d - 5],
	],
	BOARD_H,
	1.3
);

export const drawing = cardDrawing(s);
