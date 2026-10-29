import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	byDepth,
	faceRules,
	ruler,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Style guide enforcement: a go/no-go peg board. The house style is the
 * reference block at the back; every rule is a hole that takes its peg flush.
 * One peg stands proud of its hole (the lit peg): a deviation to list.
 */

const PLATE = { x: -92, y: -56, w: 184, d: 112, r: 8 };
const BOARD = { x: -40, y: -40, w: 104, d: 80, r: 5 };
const BOARD_H = 10;
const GUIDE = { x: -78, y: -40, w: 26, d: 64, r: 3 };
const GUIDE_H = 30;
const COLS = 4;
const ROWS = 3;
const ODD: [number, number] = [2, 1];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-60, -10, 40]]);

benchPlate(s, PLATE);
// The style guide: a thick reference block in a stand.
s.halo(GUIDE, 0);
s.solid(slabOf({ ...GUIDE, w: GUIDE.w + 6, x: GUIDE.x - 3 }, 0, 4, s.P, 4), {
	tone: "lo",
});
s.solid(slabOf(GUIDE, 4, GUIDE_H, s.P, 4, 0.8));
s.line(planOutline(insetPlan(GUIDE, 4), GUIDE_H + 4, s.P, 3), {
	tone: "faint",
});
faceRules(
	s,
	"x",
	GUIDE.x + GUIDE.w,
	GUIDE.y + 8,
	GUIDE_H - 2,
	[44, 34, 40, 28],
	5
);
// The peg board.
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BOARD, 4), BOARD_H, s.P, 4), { tone: "faint" });
const holes: [number, number, number, number][] = [];
for (let col = 0; col < COLS; col++) {
	for (let row = 0; row < ROWS; row++) {
		holes.push([BOARD.x + 18 + col * 23, BOARD.y + 18 + row * 22, col, row]);
	}
}
for (const [x, y, col, row] of byDepth(holes, s, BOARD_H)) {
	const odd = col === ODD[0] && row === ODD[1];
	s.line(ring(x, y, 6.5, BOARD_H, s.P, 28), { tone: "lo" });
	s.solid(cylinder(x, y, 5, BOARD_H, odd ? 14 : 2.5, s.P, 28, 0.5), {
		lit: odd,
	});
}
screws(
	s,
	[
		[BOARD.x + 8, BOARD.y + BOARD.d - 8],
		[BOARD.x + BOARD.w - 8, BOARD.y + 8],
	],
	BOARD_H,
	1.4
);
ruler(s, { x: BOARD.x, y: 44, w: BOARD.w, d: 6, r: 1 }, 0);

export const drawing = cardDrawing(s);
