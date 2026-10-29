import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Audit and questionnaire response: a gantry plotter filling in a form. The
 * questionnaire lies on the bed as rows of answer boxes; the pen carriage
 * rides a bridge across it, answering row by row. The box it has just
 * filled (the lit part) sits under the pen.
 */

const PLATE = { x: -100, y: -56, w: 200, d: 112, r: 8 };
const BED = { x: -84, y: -44, w: 168, d: 88, r: 4 };
const BED_H = 5;
const SHEET = { x: -60, y: -34, w: 116, d: 68, r: 2 };
const SHEET_TOP = BED_H + 1;
const ROWS = 5;
const BRIDGE_X = 4;
const BRIDGE_Z = 30;
const PEN_ROW = 2;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[BRIDGE_X, 0, BRIDGE_Z + 6],
]);

const rowY = (row: number) => SHEET.y + 9 + row * 12.5;

function endBlock(y: number) {
	s.solid(
		slabOf(
			{ x: BRIDGE_X - 6, y: y - 5, w: 12, d: 10, r: 2 },
			BED_H + 2,
			BRIDGE_Z - BED_H - 2,
			s.P,
			3,
			0.6
		)
	);
}

function rail(y: number) {
	s.solid(
		slabOf(
			{ x: BED.x + 4, y: y - 2, w: BED.w - 8, d: 4, r: 1 },
			BED_H,
			2,
			s.P,
			2
		),
		{
			tone: "lo",
		}
	);
}

benchPlate(s, PLATE);
s.solid(slabOf(BED, 0, BED_H, s.P, 4, 0.6));
s.line(planOutline(insetPlan(BED, 3), BED_H, s.P, 3), { tone: "faint" });
rail(BED.y + 5);
endBlock(BED.y + 5);
// The questionnaire: a box and an answer line per row.
s.solid(slabOf(SHEET, BED_H, 1, s.P, 2), { crease: "none" });
for (let row = 0; row < ROWS; row++) {
	const y = rowY(row);
	const box = { x: SHEET.x + 8, y: y - 3.5, w: 7, d: 7, r: 0.8 };
	if (row < PEN_ROW) {
		s.solid(slabOf(box, SHEET_TOP, 1, s.P, 2), { tone: "lo", crease: "none" });
	} else if (row === PEN_ROW) {
		s.solid(slabOf(box, SHEET_TOP, 1.4, s.P, 2), { lit: true, crease: "none" });
	} else {
		s.line(planOutline(box, SHEET_TOP, s.P, 2), { tone: "mid" });
	}
	if (row <= PEN_ROW) {
		// A written answer: a thin raised ink strip.
		const length = [84, 70, 52][row] ?? 60;
		s.solid(
			slabOf(
				{ x: SHEET.x + 22, y: y - 1.2, w: length, d: 2.4, r: 1 },
				SHEET_TOP,
				0.4,
				s.P,
				1
			),
			{ tone: "lo", crease: "none" }
		);
	} else {
		s.line(lineOnTop([SHEET.x + 22, y], [SHEET.x + 98, y], SHEET_TOP, s.P), {
			tone: "faint",
		});
	}
}
// The bridge across the bed, with the pen carriage on its near face.
s.solid(
	slabOf(
		{ x: BRIDGE_X - 4, y: BED.y + 2, w: 8, d: BED.d - 4, r: 1.5 },
		BRIDGE_Z,
		5,
		s.P,
		2,
		0.6
	),
	{
		tone: "lo",
	}
);
const penAt: [number, number] = [BRIDGE_X + 10, rowY(PEN_ROW)];
s.solid(cylinder(penAt[0], penAt[1], 1.4, SHEET_TOP, 6, s.P, 12));
s.solid(cylinder(penAt[0], penAt[1], 3, SHEET_TOP + 6, 12, s.P, 20));
s.solid(
	slabOf(
		{ x: BRIDGE_X + 4, y: penAt[1] - 8, w: 12, d: 16, r: 2 },
		SHEET_TOP + 18,
		BRIDGE_Z + 5 - SHEET_TOP - 18,
		s.P,
		3,
		0.6
	)
);
lamp(s, [BRIDGE_X + 10, penAt[1] - 3], BRIDGE_Z + 5, { radius: 1.6 });
screws(s, [[BRIDGE_X + 10, penAt[1] + 4]], BRIDGE_Z + 5, 1.2);
rail(BED.y + BED.d - 5);
endBlock(BED.y + BED.d - 5);

export const drawing = cardDrawing(s);
