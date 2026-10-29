import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";
import { sheetStack } from "./paper.ts";

/*
 * Discovery review and indexing: a card catalog. The document set waits in
 * the hopper tray beside it; what the run extracts (parties, dates, key
 * terms) is filed as index cards in the catalog's drawers. One drawer is
 * pulled out on its cards, the tabbed one just indexed (the lit card).
 */

const PLATE = { x: -100, y: -52, w: 200, d: 104, r: 8 };
const CAB = { x: -14, y: -44, w: 80, d: 44, r: 3 };
const CAB_H = 42;
const FRONT = CAB.y + CAB.d;
const COLS = 2;
const ROWS = 2;
const DW = (CAB.w - 12) / COLS;
const DH = (CAB_H - 10) / ROWS;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CAB.x, CAB.y, CAB_H],
]);

function drawerFront(col: number, row: number) {
	const x0 = CAB.x + 4 + col * (DW + 4);
	const z0 = 5 + row * DH;
	s.line(faceRect(s, "y", FRONT, x0, x0 + DW, z0 + 1, z0 + DH - 1), {
		tone: "lo",
	});
	s.solid(
		slabOf(
			{ x: x0 + DW / 2 - 4, y: FRONT, w: 8, d: 2, r: 0.6 },
			z0 + DH / 2 - 1,
			2,
			s.P,
			2
		),
		{ tone: "lo" }
	);
}

benchPlate(s, PLATE);
// Hopper tray holding the document set.
const hopper = { x: -90, y: -34, w: 62, d: 64, r: 3 };
s.halo(hopper, 0);
s.solid(slabOf(hopper, 0, 6, s.P, 4, 0.6), { tone: "lo" });
sheetStack(s, insetPlan(hopper, 7), 6, 6, { thick: 1.8, shift: 1.2 });
// The catalog cabinet.
s.halo(CAB, 0);
s.solid(slabOf(CAB, 0, CAB_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(CAB, 5), CAB_H, s.P, 4), { tone: "faint" });
lamp(s, [CAB.x + CAB.w - 10, CAB.y + 10], CAB_H, { radius: 1.8 });
for (let row = 0; row < ROWS; row++) {
	drawerFront(0, row);
	if (row !== 0) {
		drawerFront(1, row);
	}
}
// The pulled drawer: floor, back and far wall, cards, near wall, front.
const x0 = CAB.x + 4 + DW + 4;
const z0 = 5;
const out = 34;
const floor = { x: x0 + 1, y: FRONT, w: DW - 2, d: out, r: 1 };
s.solid(slabOf(floor, z0, 1.5, s.P, 2), { tone: "lo" });
s.solid(slabOf({ ...floor, w: 1.5 }, z0, DH - 3, s.P, 2));
const cardCount = 7;
for (let i = 0; i < cardCount; i++) {
	const y = FRONT + 2 + i * 4.4;
	const lit = i === 4;
	s.solid(
		slabOf({ x: x0 + 4, y, w: DW - 8, d: 1, r: 0.3 }, z0 + 1.5, DH + 2, s.P, 2),
		{ lit, crease: "none" }
	);
	if (lit) {
		s.solid(
			slabOf({ x: x0 + 6, y, w: 10, d: 1, r: 0.3 }, z0 + DH + 3.5, 5, s.P, 2),
			{ lit, crease: "none" }
		);
	}
}
s.solid(
	slabOf({ ...floor, x: floor.x + floor.w - 1.5, w: 1.5 }, z0, DH - 3, s.P, 2)
);
s.solid(
	slabOf(
		{ x: x0, y: FRONT + out - 2, w: DW, d: 2.5, r: 0.6 },
		z0,
		DH - 1,
		s.P,
		2
	)
);
s.solid(
	slabOf(
		{ x: x0 + DW / 2 - 4, y: FRONT + out + 0.5, w: 8, d: 2, r: 0.6 },
		z0 + DH / 2 - 1,
		2,
		s.P,
		2
	),
	{ tone: "lo" }
);

export const drawing = cardDrawing(s);
