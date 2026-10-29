import { boxCorners, cylinder, ring, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Data quality checks: a gauging tray of pegs, one per cell of the table. A
 * feeler arm sweeps the rows: one socket is empty (a null), two pegs are
 * doubled up, and the arm's probe rests on the peg that stands too tall
 * (the lit outlier).
 */

const PLATE = { x: -96, y: -54, w: 168, d: 108, r: 8 };
const TRAY = { x: -84, y: -42, w: 112, d: 80, r: 4 };
const TRAY_H = 8;
const COLS = 6;
const ROWS = 4;
const PEG_H = 10;
const OUTLIER = [3, 1];
const EMPTY = [1, 2];
const TALL = 26;
const POST = { x: 40, y: -22, w: 16, d: 16, r: 2 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [48, -14, 50]]);

const cell = (col: number, row: number): [number, number] => [
	TRAY.x + 12 + col * 17.6,
	TRAY.y + 12 + row * 18.6,
];

benchPlate(s, PLATE);
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 6, 0.8), { tone: "lo" });
const pegs: [number, number, number, number][] = [];
for (let row = 0; row < ROWS; row++) {
	for (let col = 0; col < COLS; col++) {
		const [x, y] = cell(col, row);
		pegs.push([x, y, col, row]);
	}
}
const [ox, oy] = cell(OUTLIER[0] ?? 0, OUTLIER[1] ?? 0);
for (const [x, y, col, row] of byDepth(pegs, s)) {
	s.line(ring(x, y, 5.2, TRAY_H, s.P, 24), { tone: "lo" });
	if (col === EMPTY[0] && row === EMPTY[1]) {
		continue;
	}
	const outlier = col === OUTLIER[0] && row === OUTLIER[1];
	const doubled = row === 3 && (col === 4 || col === 5);
	const height = outlier ? TALL : PEG_H;
	s.solid(cylinder(x, y, 4.4, TRAY_H, height, s.P, 24, 0.4), {
		lit: outlier,
	});
	if (doubled) {
		s.solid(cylinder(x, y, 3.4, TRAY_H + height, 5, s.P, 24, 0.4), {
			tone: "mid",
		});
	}
	if (outlier) {
		// The probe resting on top, hung from the arm.
		s.solid(cylinder(x, y, 1.6, TRAY_H + TALL, 10, s.P, 16), { tone: "lo" });
	}
}
// Feeler post past the tray's right end, nearer than the tray, so after it.
s.halo(POST, 0);
s.solid(slabOf(POST, 0, 48, s.P, 4, 0.8));
// The arm, reaching from the post to the probe.
s.solid(
	slabOf(
		{ x: ox - 4, y: oy - 4, w: POST.x + 12 - ox, d: 8, r: 1.5 },
		44,
		5,
		s.P,
		3,
		0.4
	)
);

export const drawing = cardDrawing(s);
