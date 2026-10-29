import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceLine, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Policy review and drafting: a copy stand. The standard lies open as a thick
 * book on the left, the policy sheet in a tray on the right, and one line
 * guide spans both at the same row, so the changed policy line is read
 * against the rule it quotes. The tab clipped to that line is the lit part.
 */

const PLATE = { x: -100, y: -56, w: 200, d: 112, r: 8 };
const BED = { x: -88, y: -42, w: 176, d: 84, r: 4 };
const BED_H = 4;
const BOOK = { x: -80, y: -34, w: 70, d: 68, r: 3 };
const BOOK_H = 10;
const TRAY = { x: 2, y: -34, w: 76, d: 68, r: 3 };
const TRAY_H = 4;
const GUIDE_Y = 4;
const GUIDE_Z = 18;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, GUIDE_Z + 4]]);

function rules(
	plan: { x: number; y: number; w: number },
	z: number,
	widths: number[]
) {
	widths.forEach((width, i) => {
		const y = plan.y + 8 + i * 7.5;
		if (Math.abs(y - GUIDE_Y) < 3) {
			return;
		}
		s.line(lineOnTop([plan.x + 6, y], [plan.x + 6 + width, y], z, s.P), {
			tone: i === 0 ? "mid" : "lo",
		});
	});
}

benchPlate(s, PLATE);
s.solid(slabOf(BED, 0, BED_H, s.P, 4, 0.6), { tone: "lo" });
// Guide rails along both ends of the bed.
for (const x of [BED.x + 3, BED.x + BED.w - 7]) {
	s.solid(
		slabOf({ x, y: BED.y + 4, w: 4, d: BED.d - 8, r: 1 }, BED_H, 2, s.P, 2)
	);
}
// The standard: a thick book, page edges ruled on its front.
s.halo(BOOK, BED_H);
s.solid(slabOf(BOOK, BED_H, BOOK_H, s.P, 3, 0.6));
for (let i = 1; i < 4; i++) {
	s.line(
		faceLine(
			s,
			"y",
			BOOK.y + BOOK.d,
			BOOK.x + 3,
			BOOK.x + BOOK.w - 3,
			BED_H + i * 2.4
		),
		{
			tone: "faint",
		}
	);
}
const bookTop = BED_H + BOOK_H;
s.line(
	lineOnTop(
		[BOOK.x + BOOK.w / 2, BOOK.y + 3],
		[BOOK.x + BOOK.w / 2, BOOK.y + BOOK.d - 3],
		bookTop,
		s.P
	),
	{
		tone: "lo",
	}
);
rules(
	{ x: BOOK.x, y: BOOK.y, w: 30 },
	bookTop,
	[26, 22, 28, 18, 24, 20, 26, 16]
);
rules(
	{ x: BOOK.x + BOOK.w / 2, y: BOOK.y, w: 30 },
	bookTop,
	[24, 28, 20, 26, 22, 26, 18, 24]
);
// The policy sheet in its tray.
s.halo(TRAY, BED_H);
s.solid(slabOf(TRAY, BED_H, TRAY_H, s.P, 3, 0.6));
const SHEET = insetPlan(TRAY, 5);
const sheetTop = BED_H + TRAY_H + 1;
s.solid(slabOf(SHEET, BED_H + TRAY_H, 1, s.P, 2), { crease: "none" });
rules(SHEET, sheetTop, [52, 44, 58, 40, 50, 34, 46, 38]);
// The changed line under the guide, and its tab off the sheet edge.
s.line(
	lineOnTop([SHEET.x + 6, GUIDE_Y], [SHEET.x + 54, GUIDE_Y], sheetTop, s.P),
	{
		tone: "hi",
	}
);
s.solid(
	slabOf(
		{ x: SHEET.x + SHEET.w - 4, y: GUIDE_Y - 3.5, w: 14, d: 7, r: 1 },
		sheetTop,
		1.6,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
// The line guide: two carriages on the rails and a bar across both pages.
for (const x of [BED.x + 1, BED.x + BED.w - 9]) {
	s.solid(
		slabOf(
			{ x, y: GUIDE_Y - 6, w: 8, d: 12, r: 1.5 },
			BED_H + 2,
			GUIDE_Z - BED_H - 2,
			s.P,
			3,
			0.6
		)
	);
}
s.solid(
	slabOf(
		{ x: BED.x + 1, y: GUIDE_Y - 4, w: BED.w - 2, d: 3, r: 1 },
		GUIDE_Z,
		3,
		s.P,
		2
	),
	{ tone: "lo" }
);
screws(
	s,
	[
		[BED.x + 5, GUIDE_Y],
		[BED.x + BED.w - 5, GUIDE_Y],
	],
	GUIDE_Z,
	1.2
);
// A pen standing in its cup on the near corner.
s.halo({ x: 78, y: 43, w: 12, d: 12, r: 6 }, 0);
s.solid(cylinder(84, 49, 5, 0, 3, s.P, 24), { tone: "lo" });
s.solid(cylinder(84, 49, 1.8, 3, 18, s.P, 16));

export const drawing = cardDrawing(s);
