import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Curriculum questions: a card catalogue beside a shelf of textbooks. One
 * drawer is pulled out and its index cards are up; the raised card (the lit
 * part) is the citation that points to the right book on the shelf.
 */

const PLATE = { x: -84, y: -50, w: 170, d: 92, r: 8 };
const CAB = { x: -70, y: -42, w: 66, d: 50, r: 4 };
const CAB_H = 46;
const COLS = 2;
const ROWS = 3;
const FRONT = CAB.y + CAB.d;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners(CAB, 0, CAB_H + 2),
]);

benchPlate(s, PLATE);
s.halo(CAB, 0);
s.solid(slabOf(CAB, 0, CAB_H, s.P, 6, 1));
s.line(planOutline(insetPlan(CAB, 5), CAB_H, s.P, 4), { tone: "faint" });
const cellW = (CAB.w - 12) / COLS;
const cellH = (CAB_H - 10) / ROWS;
const pulls: [number, number, number][] = [];
for (let row = 0; row < ROWS; row++) {
	for (let col = 0; col < COLS; col++) {
		if (row === 1 && col === 0) {
			continue;
		}
		const x0 = CAB.x + 6 + col * cellW + 1;
		const z0 = 5 + row * cellH + 1;
		s.line(faceRect(s, "y", FRONT, x0, x0 + cellW - 2, z0, z0 + cellH - 2), {
			tone: "lo",
		});
		pulls.push([x0 + cellW / 2 - 1, FRONT, z0 + cellH / 2 - 1]);
	}
}
s.dots(
	pulls.map((point) => s.at(point)),
	{ size: 0.9, tone: "mid" }
);
// The pulled drawer with its cards.
const dx = CAB.x + 7;
const dz = 5 + cellH + 1;
const drawer = { x: dx, y: FRONT - 4, w: cellW - 2, d: 30, r: 1.5 };
s.line(faceRect(s, "y", FRONT, dx, dx + cellW - 2, dz, dz + cellH - 2), {
	tone: "mid",
});
s.solid(slabOf(drawer, dz, cellH - 2, s.P, 2, 0.4));
for (let i = 0; i < 4; i++) {
	const lit = i === 1;
	s.solid(
		slabOf(
			{ x: dx + 2.5, y: FRONT + 3 + i * 6, w: cellW - 7, d: 1.2, r: 0.3 },
			dz + cellH - 2,
			lit ? 12 : 5,
			s.P,
			2
		),
		{ lit, crease: "none" }
	);
}
// The textbook shelf, books standing spine forward.
const books = [
	[8, 9, 34],
	[18, 7, 30],
	[26, 10, 38],
	[37, 8, 28],
	[46, 9, 33],
];
s.halo({ x: 6, y: -32, w: 70, d: 40, r: 2 }, 0);
s.solid(slabOf({ x: 4, y: -34, w: 74, d: 44, r: 2 }, 0, 3, s.P, 3, 0.4), {
	tone: "lo",
});
for (const [x, w, h] of books) {
	s.solid(
		slabOf(
			{ x: x ?? 0, y: -28, w: (w ?? 8) - 1, d: 34, r: 1 },
			3,
			h ?? 30,
			s.P,
			2,
			0.4
		)
	);
}
s.solid(slabOf({ x: 58, y: -28, w: 16, d: 34, r: 1 }, 3, 2, s.P, 2));
s.solid(slabOf({ x: 70, y: -28, w: 3, d: 34, r: 0.5 }, 5, 22, s.P, 2), {
	tone: "lo",
});

export const drawing = cardDrawing(s);
