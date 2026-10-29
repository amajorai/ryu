import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Showing coordination: a peg calendar, days across and time slots down.
 * Pegs mark the slots proposed to the buyer; the one the seller confirmed is
 * the lit peg. The listing's key lockbox stands beside it.
 */

const PLATE = { x: -100, y: -52, w: 200, d: 104, r: 8 };
const BOARD = { x: -86, y: -38, w: 112, d: 78, r: 4 };
const BOARD_H = 8;
const COLS = 5;
const ROWS = 4;
const LOCK = { x: 44, y: -22, w: 30, d: 34, r: 4 };
const LOCK_H = 24;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[58, -6, LOCK_H + 12],
]);

const hole = (col: number, row: number): [number, number, number, number] => [
	BOARD.x + 18 + col * 19,
	BOARD.y + 24 + row * 14,
	col,
	row,
];

benchPlate(s, PLATE);
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 6, 0.8));
// Day header: a raised rail with one tab per day.
s.solid(
	slabOf(
		{ x: BOARD.x + 6, y: BOARD.y + 5, w: BOARD.w - 12, d: 8, r: 2 },
		BOARD_H,
		3,
		s.P,
		3
	),
	{
		tone: "lo",
	}
);
for (let col = 0; col < COLS; col++) {
	s.solid(
		slabOf(
			{ x: BOARD.x + 13 + col * 19, y: BOARD.y + 7, w: 10, d: 4, r: 1 },
			BOARD_H + 3,
			2,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
const holes: [number, number, number, number][] = [];
for (let col = 0; col < COLS; col++) {
	for (let row = 0; row < ROWS; row++) {
		holes.push(hole(col, row));
	}
}
s.line(holes.map(([x, y]) => ring(x, y, 3.2, BOARD_H, s.P, 16)).join(""), {
	tone: "lo",
});
const pegs = new Set(["1,2", "2,0", "3,1", "4,3"]);
for (const [x, y, col, row] of byDepth(holes, s, BOARD_H)) {
	if (!pegs.has(`${col},${row}`)) {
		continue;
	}
	const lit = col === 3 && row === 1;
	s.solid(cylinder(x, y, 3, BOARD_H, 10, s.P, 20), { lit });
	s.solid(cylinder(x, y, 4.6, BOARD_H + 10, 2.4, s.P, 24), { lit });
}
// Key lockbox: body, keypad, shackle on top.
s.halo(LOCK, 0);
s.solid(slabOf(LOCK, 0, LOCK_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(LOCK, 4), LOCK_H, s.P, 4), { tone: "faint" });
s.solid(cylinder(LOCK.x + 8, LOCK.y + 9, 2, LOCK_H, 8, s.P, 16));
s.solid(cylinder(LOCK.x + 22, LOCK.y + 9, 2, LOCK_H, 8, s.P, 16));
s.solid(
	slabOf(
		{ x: LOCK.x + 5, y: LOCK.y + 6, w: 20, d: 6, r: 3 },
		LOCK_H + 8,
		3,
		s.P,
		6
	)
);
const keypad: string[] = [];
for (let row = 0; row < 3; row++) {
	for (let col = 0; col < 3; col++) {
		keypad.push(
			ring(LOCK.x + 8 + col * 5, LOCK.y + 16 + row * 5, 1.6, LOCK_H, s.P, 12)
		);
	}
}
s.line(keypad.join(""), { tone: "mid" });
lamp(s, [LOCK.x + 24, LOCK.y + 28], LOCK_H, { radius: 1.5 });

export const drawing = cardDrawing(s);
