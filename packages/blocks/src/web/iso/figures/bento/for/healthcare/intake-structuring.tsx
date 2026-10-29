import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Intake structuring: a pigeonhole sorter. Loose intake sheets wait in the
 * tray in front; each detail is filed into its own cubby, one field per
 * slot. One cubby is still empty, and the lamp above it (the lit part) flags
 * the missing detail.
 */

const PLATE = { x: -100, y: -44, w: 194, d: 84, r: 8 };
const TRAY = { x: -88, y: -14, w: 58, d: 44, r: 3 };
const CABINET = { x: -14, y: -36, w: 96, d: 40, r: 3 };
const CAB_H = 58;
const FRONT = CABINET.y + CABINET.d;
const COLUMNS = [-8, 22, 52];
const ROWS = [6, 23, 40];
const CELL = { w: 26, h: 14 };
const EMPTY = { column: 1, row: 2 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[30, CABINET.y, CAB_H + 4],
]);

benchPlate(s, PLATE);
// The cabinet: a plinth, the case, a grid of open cubbies on its front.
s.halo(CABINET, 0);
s.solid(slabOf(insetPlan(CABINET, -2), 0, 3, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(CABINET, 3, CAB_H - 3, s.P, 6, 0.8));
s.line(planOutline(insetPlan(CABINET, 4), CAB_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[CABINET.x + 8, CABINET.y + 8],
		[CABINET.x + CABINET.w - 8, CABINET.y + 8],
	],
	CAB_H,
	1.4
);
COLUMNS.forEach((x, column) => {
	lamp(s, [x + CELL.w / 2, FRONT - 7], CAB_H, {
		lit: column === EMPTY.column,
		radius: 3.4,
	});
});
ROWS.forEach((z, row) => {
	COLUMNS.forEach((x, column) => {
		const empty = column === EMPTY.column && row === EMPTY.row;
		s.line(faceRect(s, "y", FRONT, x, x + CELL.w, z, z + CELL.h), {
			tone: empty ? "mid" : "lo",
		});
		if (empty) {
			// The open slot's far wall, seen through the opening.
			s.line(
				faceRect(
					s,
					"y",
					FRONT - 10,
					x + 3,
					x + CELL.w - 3,
					z + 2,
					z + CELL.h - 2
				),
				{
					tone: "faint",
				}
			);
		}
		if (!empty) {
			// A filed slip, standing proud of its slot.
			s.solid(
				slabOf(
					{ x: x + 3, y: FRONT, w: CELL.w - 6, d: 8, r: 0.5 },
					z,
					CELL.h - 2 - ((row + column) % 2) * 3,
					s.P,
					2
				),
				{ crease: "none" }
			);
		}
	});
});
// The intake tray of loose free-text sheets.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 6, s.P, 4, 0.6), { tone: "lo" });
const nudges: [number, number][] = [
	[-2, 2],
	[3, -1],
	[-1, -3],
	[2, 1],
];
nudges.forEach(([dx, dy], i) => {
	s.solid(
		slabOf(
			{ x: TRAY.x + 9 + dx, y: TRAY.y + 6 + dy, w: 40, d: 32, r: 1 },
			6 + i * 1.4,
			1.4,
			s.P,
			2
		),
		{ crease: "none" }
	);
});

export const drawing = cardDrawing(s);
