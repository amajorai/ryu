import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Library questions: a card catalogue. Every paper in the library has its
 * card in a drawer; asking a question pulls the right drawer open and lifts
 * the one card that answers it (the lit card), so the answer comes with the
 * paper and section it cites.
 */

const PLATE = { x: -74, y: -58, w: 148, d: 116, r: 8 };
const CAB = { x: -52, y: -46, w: 96, d: 54, r: 4 };
const CAB_H = 54;
const COLS = 2;
const ROWS = 3;
const OPEN = { col: 0, row: 1 };
const PULL = 30;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-14, -18, CAB_H + 6],
]);

const front = CAB.y + CAB.d;
const dw = (CAB.w - 12) / COLS;
const dh = (CAB_H - 12) / ROWS;
const drawerX = (col: number) => CAB.x + 6 + col * dw;
const drawerZ = (row: number) => CAB_H - 6 - (row + 1) * dh;

benchPlate(s, PLATE);
s.halo(CAB, 0);
// Plinth, then the cabinet body with a lid lip.
s.solid(slabOf(insetPlan(CAB, -3), 0, 4, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(CAB, 4, CAB_H - 4, s.P, 6, 0.8));
s.solid(slabOf(insetPlan(CAB, -2), CAB_H, 4, s.P, 4, 0.6));
s.line(planOutline(insetPlan(CAB, 6), CAB_H + 4, s.P, 4), { tone: "faint" });
lamp(s, [CAB.x + CAB.w - 10, CAB.y + 10], CAB_H + 4, { radius: 1.8 });
// Drawer fronts, each with a label frame and a pull.
for (let row = 0; row < ROWS; row++) {
	for (let col = 0; col < COLS; col++) {
		const x0 = drawerX(col) + 1.5;
		const x1 = drawerX(col) + dw - 1.5;
		const z0 = drawerZ(row) + 1.5;
		const z1 = drawerZ(row) + dh - 1.5;
		s.line(faceRect(s, "y", front, x0, x1, z0, z1), { tone: "lo" });
		if (col === OPEN.col && row === OPEN.row) {
			continue;
		}
		const mid = (x0 + x1) / 2;
		s.line(faceRect(s, "y", front, mid - 8, mid + 8, z1 - 4, z1 - 1.5), {
			tone: "faint",
		});
		s.line(faceRect(s, "y", front, mid - 4, mid + 4, z0 + 2, z0 + 4), {
			tone: "mid",
		});
	}
}
// The open drawer, its cards standing on edge, one lifted.
const drawer = {
	x: drawerX(OPEN.col) + 2,
	y: front - 4,
	w: dw - 4,
	d: PULL + 4,
	r: 1,
};
const dz = drawerZ(OPEN.row) + 2;
s.solid(slabOf(drawer, dz, dh - 4, s.P, 2, 0.4), { tone: "lo" });
const cards = 6;
for (let i = 0; i < cards; i++) {
	const lifted = i === 3;
	s.solid(
		slabOf(
			{
				x: drawer.x + 3,
				y: drawer.y + 6 + i * 5,
				w: drawer.w - 6,
				d: 1.4,
				r: 0.3,
			},
			dz + 2,
			dh - 6 + (lifted ? 8 : 0),
			s.P,
			2
		),
		{ lit: lifted, crease: "none" }
	);
}
const pullX = drawer.x + drawer.w / 2;
s.line(
	faceRect(s, "y", drawer.y + drawer.d, pullX - 3, pullX + 3, dz + 2, dz + 4),
	{ tone: "mid" }
);

export const drawing = cardDrawing(s);
