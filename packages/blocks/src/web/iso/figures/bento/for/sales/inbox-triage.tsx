import {
	boxCorners,
	cylinder,
	insetPlan,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Inbox triage: a pigeonhole sorter. Inbound replies wait in the tray in
 * front and are sorted into cubbies, a drafted response tucked in with each;
 * the flag raised on top (the lit part) marks the deal that needs you.
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const CAB = { x: -78, y: -40, w: 96, d: 44, r: 3 };
const CAB_H = 50;
const FRONT = CAB.y + CAB.d;
const COLS = 3;
const ROWS = 2;
const CELL_W = (CAB.w - 12) / COLS;
const CELL_H = (CAB_H - 12) / ROWS;
const TRAY = { x: 30, y: -12, w: 54, d: 44, r: 3 };
const FLAG: [number, number] = [CAB.x + CAB.w - 12, CAB.y + 10];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[FLAG[0], FLAG[1], CAB_H + 26],
]);

benchPlate(s, PLATE);
s.halo(CAB, 0);
s.solid(slabOf(CAB, 0, CAB_H, s.P, 4, 1));
screws(s, [[CAB.x + 8, CAB.y + 8]], CAB_H, 1.4);
// Flag on its post, raised.
s.solid(cylinder(FLAG[0], FLAG[1], 3, CAB_H, 1.6, s.P, 20), { tone: "lo" });
s.solid(cylinder(FLAG[0], FLAG[1], 1.2, CAB_H + 1.6, 24, s.P, 12));
s.solid(
	slabOf(
		{ x: FLAG[0] + 1, y: FLAG[1] - 1, w: 16, d: 2, r: 0.4 },
		CAB_H + 14,
		10,
		s.P,
		2
	),
	{
		lit: true,
		crease: "none",
	}
);
// Cubbies on the front face, each holding a letter edge-out.
for (let row = 0; row < ROWS; row++) {
	for (let col = 0; col < COLS; col++) {
		const x0 = CAB.x + 6 + col * CELL_W;
		const z0 = 6 + row * CELL_H;
		s.line(
			faceRect(
				s,
				"y",
				FRONT,
				x0 + 1.5,
				x0 + CELL_W - 1.5,
				z0 + 1.5,
				z0 + CELL_H - 1.5
			),
			{
				tone: "lo",
			}
		);
		const count = (row * COLS + col) % 3;
		for (let i = 0; i < count; i++) {
			s.solid(
				slabOf(
					{ x: x0 + 4 + i * 3, y: FRONT - 3, w: CELL_W - 12, d: 9, r: 0.5 },
					z0 + 2.5 + i * 3,
					2,
					s.P,
					2
				),
				{ crease: "none" }
			);
		}
	}
}
// In-tray in front with the unsorted stack.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 3, s.P, 4, 0.6), { tone: "lo" });
s.solid(
	slabOf({ x: TRAY.x + 4, y: TRAY.y, w: 4, d: TRAY.d, r: 1 }, 3, 8, s.P, 2),
	{
		tone: "lo",
	}
);
const sheet = insetPlan(TRAY, 7);
for (let i = 0; i < 4; i++) {
	s.solid(
		slabOf(
			{ ...sheet, x: sheet.x + (i % 2) * 2, y: sheet.y - i },
			3 + i * 1.6,
			1.6,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
s.solid(
	slabOf(
		{ x: TRAY.x + TRAY.w - 8, y: TRAY.y, w: 4, d: TRAY.d, r: 1 },
		3,
		8,
		s.P,
		2
	),
	{
		tone: "lo",
	}
);

export const drawing = cardDrawing(s);
