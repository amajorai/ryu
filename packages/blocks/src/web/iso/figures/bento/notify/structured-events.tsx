import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Structured events: a carry caddy whose four compartments travel together
 * under one handle: the source (a plug), the type (a stamp), the recipient (a
 * pawn) and the data (a stack of record cards, the top one lit).
 */

const PLATE = { x: -92, y: -54, w: 184, d: 108, r: 8 };
const CASE = { x: -76, y: -42, w: 152, d: 84, r: 5 };
const CASE_H = 10;
const MID_X = CASE.x + CASE.w / 2;
const HANDLE_TOP = 44;
const POST_W = 8;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[MID_X - 2, CASE.y + 2, HANDLE_TOP + 2],
]);

const cell = (column: number, row: number) =>
	insetPlan(
		{
			x: CASE.x + column * (CASE.w / 2),
			y: CASE.y + row * (CASE.d / 2),
			w: CASE.w / 2,
			d: CASE.d / 2,
			r: 3,
		},
		5
	);
const centre = (column: number, row: number): [number, number] => {
	const plan = cell(column, row);
	return [plan.x + plan.w / 2, plan.y + plan.d / 2];
};

function plug() {
	// Set back in its cell so the handle does not cross it.
	const [cx, cy] = centre(0, 0);
	const x = cx - 16;
	const y = cy - 4;
	s.solid(cylinder(x, y, 12, CASE_H, 9, s.P, 36, 0.6));
	s.line(ring(x, y, 8.5, CASE_H + 9, s.P, 28), { tone: "faint" });
	s.solid(cylinder(x - 4, y, 1.8, CASE_H + 9, 8, s.P, 12), { tone: "lo" });
	s.solid(cylinder(x + 4, y, 1.8, CASE_H + 9, 8, s.P, 12), { tone: "lo" });
}

function stamp() {
	const [x, y] = centre(1, 0);
	s.solid(
		slabOf(
			{ x: x - 16, y: y - 11, w: 32, d: 22, r: 2 },
			CASE_H,
			7,
			s.P,
			3,
			0.4
		),
		{ tone: "lo" }
	);
	s.solid(cylinder(x, y, 3.5, CASE_H + 7, 9, s.P, 16));
	s.solid(cylinder(x, y, 8, CASE_H + 16, 7, s.P, 28, 1.2));
}

function handle() {
	// Two end posts on the case walls and a grip bar between them.
	for (const y of [CASE.y + 2, CASE.y + CASE.d - 2 - POST_W]) {
		s.solid(
			slabOf(
				{ x: MID_X - 3, y, w: 6, d: POST_W, r: 1.5 },
				CASE_H,
				HANDLE_TOP - CASE_H,
				s.P,
				3,
				0.4
			)
		);
	}
	s.solid(
		slabOf(
			{ x: MID_X - 3, y: CASE.y + 2, w: 6, d: CASE.d - 4, r: 2 },
			HANDLE_TOP - 6,
			6,
			s.P,
			3,
			0.6
		),
		{ tone: "lo" }
	);
}

function pawn() {
	const [x, y] = centre(0, 1);
	s.solid(cylinder(x, y, 11, CASE_H, 4, s.P, 32, 0.6), { tone: "lo" });
	s.solid(cylinder(x, y, 7, CASE_H + 4, 4, s.P, 28));
	s.solid(cylinder(x, y, 4.5, CASE_H + 8, 10, s.P, 24));
	s.solid(cylinder(x, y, 7, CASE_H + 18, 7, s.P, 28, 2));
}

function records() {
	const [x, y] = centre(1, 1);
	for (let index = 0; index < 4; index++) {
		s.solid(
			slabOf(
				{ x: x - 20, y: y - 12, w: 40, d: 24, r: 1.5 },
				CASE_H + index * 3,
				2.4,
				s.P,
				3
			),
			{ lit: index === 3, crease: "none" }
		);
	}
}

benchPlate(s, PLATE);
s.halo(CASE, 0);
s.solid(slabOf(CASE, 0, CASE_H, s.P, 6, 0.8));
for (const [column, row] of [
	[0, 0],
	[1, 0],
	[0, 1],
	[1, 1],
] as const) {
	s.line(planOutline(cell(column, row), CASE_H, s.P, 3), { tone: "lo" });
}
screws(s, [[CASE.x + CASE.w - 4, CASE.y + 4]], CASE_H, 1.2);
// Far column, then the handle over the middle wall, then the near column.
plug();
pawn();
handle();
stamp();
records();

export const drawing = cardDrawing(s);
