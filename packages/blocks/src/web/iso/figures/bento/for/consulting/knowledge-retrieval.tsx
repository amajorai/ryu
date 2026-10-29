import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Knowledge retrieval: a card catalogue of the firm's prior work. One drawer
 * is pulled out and the card that answers the question stands raised in it
 * (the lit part); the slips on the spindle beside it are its citations.
 */

const PLATE = { x: -78, y: -54, w: 156, d: 98, r: 8 };
const CAB = { x: -62, y: -42, w: 66, d: 48, r: 4 };
const CAB_H = 48;
const FRONT = CAB.y + CAB.d;
const COLS = 2;
const ROWS = 3;
const CELL_W = (CAB.w - 8) / COLS;
const CELL_H = (CAB_H - 8) / ROWS;
const OPEN = { col: 1, row: 1 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners(CAB, 0, CAB_H),
]);

benchPlate(s, PLATE);
s.halo(CAB, 0);
s.solid(slabOf(CAB, 0, CAB_H, s.P, 6, 1));
s.line(planOutline(insetPlan(CAB, 5), CAB_H, s.P, 4), { tone: "faint" });
const pulls: [number, number, number][] = [];
for (let row = 0; row < ROWS; row++) {
	for (let col = 0; col < COLS; col++) {
		const x0 = CAB.x + 4 + col * CELL_W;
		const z0 = 4 + row * CELL_H;
		s.line(
			faceRect(s, "y", FRONT, x0 + 1, x0 + CELL_W - 1, z0 + 1, z0 + CELL_H - 1),
			{
				tone: "lo",
			}
		);
		const mx = x0 + CELL_W / 2;
		s.line(
			faceRect(s, "y", FRONT, mx - 5, mx + 5, z0 + CELL_H - 6, z0 + CELL_H - 3),
			{
				tone: "faint",
			}
		);
		if (!(row === OPEN.row && col === OPEN.col)) {
			pulls.push([mx, FRONT, z0 + CELL_H / 2 - 1]);
		}
	}
}
s.dots(
	pulls.map((p) => s.at(p)),
	{ size: 1.1 }
);
// The open drawer, with its cards and the one that answers.
const x0 = CAB.x + 4 + OPEN.col * CELL_W + 2;
const z0 = 4 + OPEN.row * CELL_H + 2;
const drawer = { x: x0, y: FRONT - 6, w: CELL_W - 4, d: 30, r: 1.5 };
s.solid(slabOf(drawer, z0, CELL_H - 4, s.P, 3, 0.6));
const rim = z0 + CELL_H - 4;
s.line(planOutline(insetPlan(drawer, 2), rim, s.P, 2), { tone: "lo" });
for (let i = 0; i < 4; i++) {
	const lit = i === 1;
	s.solid(
		slabOf(
			{
				x: drawer.x + 4,
				y: drawer.y + 6 + i * 5,
				w: drawer.w - 8,
				d: 1.6,
				r: 0.4,
			},
			rim,
			lit ? 12 : 4,
			s.P,
			2
		),
		lit ? { lit, crease: "none" } : { crease: "none" }
	);
}
// Citation spindle: slips pinned on a post.
const SPINDLE: [number, number] = [44, 8];
s.halo({ x: SPINDLE[0] - 12, y: SPINDLE[1] - 12, w: 28, d: 28, r: 14 }, 0);
s.solid(cylinder(SPINDLE[0], SPINDLE[1], 13, 0, 3, s.P, 36, 0.6), {
	tone: "lo",
});
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf(
			{ x: SPINDLE[0] - 12 + i * 2, y: SPINDLE[1] - 8 - i, w: 24, d: 16, r: 1 },
			3 + i * 1.6,
			1,
			s.P,
			2
		),
		{ crease: "none", tone: i === 2 ? "mid" : "lo" }
	);
}
s.solid(cylinder(SPINDLE[0], SPINDLE[1], 0.9, 7.2, 18.6, s.P, 12));
s.solid(cylinder(SPINDLE[0], SPINDLE[1], 1.8, 25.8, 1.6, s.P, 16), {
	tone: "lo",
});

export const drawing = cardDrawing(s);
