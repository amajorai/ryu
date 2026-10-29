import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";
import { sheetStack } from "./paper.ts";

/*
 * Document summarization: a book press. A thick ream of filings sits under
 * the platen between two posts, squeezed by the handwheel screw; what comes
 * out is the one thin summary sheet in the tray beside it (the lit sheet),
 * with citation flags along its edge pointing back to page and line.
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const BED = { x: -88, y: -30, w: 84, d: 60, r: 4 };
const BED_H = 6;
const CX = BED.x + BED.w / 2;
const POST_H = 44;
const WHEEL_Z = POST_H + 8;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CX, 0, WHEEL_Z + 4],
]);

function post(x: number) {
	const plan = { x: x - 6, y: -7, w: 12, d: 14, r: 2 };
	s.solid(slabOf(plan, BED_H, POST_H - BED_H, s.P, 4, 0.6));
}

benchPlate(s, PLATE);
s.halo(BED, 0);
s.solid(slabOf(BED, 0, BED_H, s.P, 6, 0.8), { tone: "lo" });
post(BED.x + 6);
// The ream of filings under the platen.
const ream = { x: CX - 22, y: -20, w: 44, d: 40, r: 1 };
const top = sheetStack(s, ream, BED_H, 8, { thick: 1.8, shift: 1.4 });
const platen = { x: CX - 25, y: -22, w: 50, d: 44, r: 3 };
s.solid(slabOf(platen, top, 5, s.P, 4, 0.6));
s.line(planOutline(insetPlan(platen, 5), top + 5, s.P, 3), { tone: "faint" });
s.solid(cylinder(CX, 0, 3.4, top + 5, POST_H - top - 5, s.P, 20), {
	tone: "lo",
});
post(BED.x + BED.w - 6);
// Crossbeam over both posts, the screw running through it to the handwheel.
s.solid(
	slabOf({ x: BED.x, y: -9, w: BED.w, d: 18, r: 3 }, POST_H, 7, s.P, 4, 0.8)
);
screws(
	s,
	[
		[BED.x + 6, 0],
		[BED.x + BED.w - 6, 0],
	],
	POST_H + 7,
	1.6
);
s.solid(cylinder(CX, 0, 3.4, POST_H + 7, WHEEL_Z - POST_H - 7, s.P, 20), {
	tone: "lo",
});
s.solid(cylinder(CX, 0, 14, WHEEL_Z, 3, s.P, 40, 0.5));
s.line(knurl(CX, 0, 14, WHEEL_Z, WHEEL_Z + 3, 40, s.P), { tone: "lo" });
s.line(ring(CX, 0, 9, WHEEL_Z + 3, s.P, 36), { tone: "lo" });
s.solid(cylinder(CX, 0, 4, WHEEL_Z + 3, 2, s.P, 20), { tone: "lo" });
// Out tray: the summary sheet, flagged with its citations.
const tray = { x: 16, y: -30, w: 70, d: 62, r: 4 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 5, s.P, 4, 0.6));
const sheet = { x: 24, y: -22, w: 50, d: 46, r: 1 };
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf(
			{ x: sheet.x + sheet.w - 2, y: sheet.y + 6 + i * 13, w: 9, d: 5, r: 1 },
			5,
			1.4,
			s.P,
			2
		),
		{ tone: "lo", crease: "none" }
	);
}
s.solid(slabOf(sheet, 5, 1.4, s.P, 2), { lit: true, crease: "none" });
for (let i = 0; i < 5; i++) {
	const y = sheet.y + 7 + i * 8;
	const length = [36, 28, 34, 22, 30][i] ?? 30;
	s.line(lineOnTop([sheet.x + 6, y], [sheet.x + 6 + length, y], 6.4, s.P), {
		tone: i === 0 ? "mid" : "lo",
	});
}

export const drawing = cardDrawing(s);
