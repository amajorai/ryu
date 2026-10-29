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
 * Model evaluation: a confusion-matrix sorting tray. Every prediction drops a
 * chip into one of four bins, right or wrong by row and column. The tall
 * stacks sit on the diagonal; the misses pile in an off-diagonal bin, and
 * the chip that shows where the model fails is lit.
 */

const PLATE = { x: -72, y: -62, w: 152, d: 118, r: 8 };
const BIN_W = 46;
const BIN_D = 40;
const BIN_H = 8;
const CHIP = 2.4;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-28, -24, 30]]);

// [column, row, chips]: diagonal bins are right, the others are wrong.
const bins: [number, number, number][] = [
	[0, 0, 6],
	[1, 0, 2],
	[0, 1, 3],
	[1, 1, 5],
];

benchPlate(s, PLATE);
const FRAME = { x: -54, y: -48, w: 104, d: 92, r: 5 };
s.halo(FRAME, 0);
s.solid(slabOf(FRAME, 0, 3, s.P, 5, 0.6), { tone: "lo" });
for (const [col, row, chips] of byDepth(
	bins.map(([c, r, n]): [number, number, number] => [
		c * 50 - 50,
		r * 44 - 44,
		n,
	]),
	s
)) {
	const plan = { x: col, y: row, w: BIN_W, d: BIN_D, r: 3 };
	s.solid(slabOf(plan, 3, BIN_H, s.P, 4, 0.6));
	s.line(planOutline(insetPlan(plan, 4), BIN_H + 3, s.P, 3), { tone: "lo" });
	const [cx, cy] = [col + BIN_W / 2, row + BIN_D / 2];
	const miss = col === -50 && row === 0;
	for (let i = 0; i < chips; i++) {
		const z = BIN_H + 3 + i * CHIP;
		s.solid(cylinder(cx, cy, 9, z, CHIP, s.P, 32, 0.3), {
			lit: miss && i === chips - 1,
			crease: "none",
		});
	}
	s.line(ring(cx, cy, 5, BIN_H + 3 + chips * CHIP, s.P, 24), { tone: "faint" });
}
// Count lamps in a column on the open right edge of the plate.
for (const y of [-6, 4, 14]) {
	lamp(s, [66, y], 0, { radius: 2 });
}

export const drawing = cardDrawing(s);
