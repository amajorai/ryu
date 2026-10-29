import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Deduction and credit review: a flatbed scanner. The client's records lie
 * on the glass as rows of entries; the scan carriage has swept the page and
 * one entry it passed is marked (the lit strip): a deduction left unclaimed.
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const BED = { x: -82, y: -42, w: 152, d: 84, r: 5 };
const BED_H = 10;
const SHEET = { x: -68, y: -30, w: 96, d: 60, r: 2 };
const SHEET_Z = BED_H;
const TOP = SHEET_Z + 1;
const CARRIAGE_X = -24;
const RAIL_D = 5;
const MARKED = 4;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CARRIAGE_X, 0, BED_H + 20],
]);

benchPlate(s, PLATE);
s.halo(BED, 0);
s.solid(slabOf(BED, 0, BED_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BED, 4), BED_H, s.P, 4), { tone: "faint" });
// Side rails the carriage runs on.
for (const y of [BED.y + 3, BED.y + BED.d - 3 - RAIL_D]) {
	s.solid(
		slabOf({ x: BED.x + 6, y, w: 112, d: RAIL_D, r: 1 }, BED_H, 2, s.P, 2),
		{ tone: "lo" }
	);
}
s.solid(slabOf(SHEET, SHEET_Z, 1, s.P, 2), { crease: "none" });
for (const [i, span] of [76, 60, 72, 54, 70, 66, 48].entries()) {
	const y = SHEET.y + 7 + i * 7.6;
	if (i === MARKED) {
		s.solid(
			slabOf(
				{ x: SHEET.x + 6, y: y - 2.4, w: 70, d: 4.8, r: 1 },
				TOP,
				1.4,
				s.P,
				2
			),
			{ lit: true, crease: "none" }
		);
	} else {
		const end = SHEET.x + 6 + span;
		s.line(lineOnTop([SHEET.x + 6, y], [end, y], TOP, s.P), {
			tone: i === 0 ? "mid" : "lo",
		});
	}
}
// The carriage: two shoes on the rails and the scan bar across them.
const rail0 = BED.y + 2;
const rail1 = BED.y + BED.d - 2 - RAIL_D - 2;
for (const y of [rail0, rail1]) {
	s.solid(
		slabOf(
			{ x: CARRIAGE_X - 7, y, w: 14, d: RAIL_D + 2, r: 1.5 },
			BED_H + 2,
			12,
			s.P,
			3,
			0.4
		)
	);
}
s.solid(
	slabOf(
		{ x: CARRIAGE_X - 8, y: rail0, w: 16, d: rail1 - rail0 + RAIL_D + 2, r: 2 },
		BED_H + 14,
		6,
		s.P,
		3,
		0.6
	)
);
s.line(
	lineOnTop([CARRIAGE_X, rail0 + 4], [CARRIAGE_X, rail1 + 3], BED_H + 20, s.P),
	{
		tone: "lo",
	}
);
// Control corner: a knob and an idle lamp.
knob(s, [48, -14], BED_H, 6, 5);
lamp(s, [48, 10], BED_H, { radius: 2 });
screws(
	s,
	[
		[60, 24],
		[60, -30],
	],
	BED_H,
	1.4
);

export const drawing = cardDrawing(s);
