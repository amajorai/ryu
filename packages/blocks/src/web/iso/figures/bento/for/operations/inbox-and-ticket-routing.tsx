import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Inbox and ticket routing: a sorting rack. Requests wait in the intake tray
 * at the front; each one is read and slid into the pigeonhole of its queue,
 * and the ticket just routed (lit) still sticks out of its cubby. The small
 * tray on the right holds the drafted acknowledgements.
 */

const PLATE = { x: -102, y: -56, w: 176, d: 104, r: 8 };
const RACK = { x: -36, y: -48, w: 96, d: 34, r: 3 };
const RACK_H = 60;
const FRONT = RACK.y + RACK.d;
const COLS = 3;
const ROWS = 3;
const CELL_W = 28;
const CELL_H = 16;
const ROUTED = { col: 1, row: 1 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners(RACK, 0, RACK_H + 2),
]);

function cell(col: number, row: number) {
	const x0 = RACK.x + 5 + col * (CELL_W + 3);
	const z0 = 5 + row * (CELL_H + 3);
	return { x0, x1: x0 + CELL_W, z0, z1: z0 + CELL_H };
}

function tray(plan: typeof RACK, cards: number, lines: number) {
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, 5, s.P, 4, 0.6), { tone: "lo" });
	const card = insetPlan(plan, 6);
	for (let i = 0; i < cards; i++) {
		s.solid(slabOf({ ...card, y: card.y - i * 0.8 }, 5 + i * 2, 2, s.P, 3), {
			crease: "none",
		});
	}
	const top = 5 + cards * 2;
	for (let i = 0; i < lines; i++) {
		const y = card.y + 6 + i * 6;
		s.line(
			lineOnTop([card.x + 5, y], [card.x + card.w - 8 - i * 4, y], top, s.P),
			{
				tone: "lo",
			}
		);
	}
}

benchPlate(s, PLATE);
// The pigeonhole rack.
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(RACK, 4), RACK_H, s.P, 4), { tone: "faint" });
for (let col = 0; col < COLS; col++) {
	for (let row = 0; row < ROWS; row++) {
		const c = cell(col, row);
		s.line(faceRect(s, "y", FRONT, c.x0, c.x1, c.z0, c.z1), { tone: "mid" });
		s.line(faceRect(s, "y", FRONT, c.x0 + 3, c.x1 - 3, c.z0, c.z1 - 4), {
			tone: "faint",
		});
	}
}
lamp(s, [RACK.x + RACK.w - 8, RACK.y + 8], RACK_H, { radius: 2 });
// The ticket just routed, sticking out of its cubby.
const routed = cell(ROUTED.col, ROUTED.row);
s.solid(
	slabOf(
		{ x: routed.x0 + 4, y: FRONT, w: CELL_W - 8, d: 16, r: 1 },
		routed.z0,
		6,
		s.P,
		2
	),
	{ lit: true }
);
tray({ x: -92, y: -6, w: 48, d: 44, r: 3 }, 4, 4);
tray({ x: 30, y: 6, w: 40, d: 34, r: 3 }, 2, 3);

export const drawing = cardDrawing(s);
