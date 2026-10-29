import {
	boxCorners,
	cylinder,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * First-pass drafting: a stamping press fed from your own templates. The
 * template rack stands beside it with one plate gone; that plate is in the
 * press head (the lit block), about to set a fresh draft on the bed, and
 * finished drafts stack up in the tray in front.
 */

const PLATE = { x: -98, y: -54, w: 196, d: 108, r: 8 };
const RACK = { x: -88, y: -40, w: 36, d: 64, r: 3 };
const BED = { x: -38, y: -40, w: 76, d: 72, r: 4 };
const BED_H = 8;
const COLUMN = { x: -8, y: -38, w: 16, d: 14, r: 2 };
const ARM_Z = 56;
const ARM_H = 8;
const HEAD: [number, number] = [0, 2];
const STAMP_Z = 22;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, -20, ARM_Z + ARM_H + 8],
]);

benchPlate(s, PLATE);
// Template rack: a slotted block holding upright plates, one slot empty.
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, 6, s.P, 4, 0.6), { tone: "lo" });
[0, 1, 3].forEach((slot) => {
	const x = RACK.x + 6 + slot * 7.5;
	s.solid(
		slabOf({ x, y: RACK.y + 6, w: 3, d: RACK.d - 12, r: 0.6 }, 6, 24, s.P, 2)
	);
	s.solid(slabOf({ x, y: RACK.y + 20, w: 3, d: 12, r: 0.6 }, 30, 4, s.P, 2));
});
s.line(
	lineOnTop(
		[RACK.x + 6 + 2 * 7.5 + 1.5, RACK.y + 6],
		[RACK.x + 6 + 2 * 7.5 + 1.5, RACK.y + RACK.d - 6],
		6,
		s.P
	),
	{ tone: "mid" }
);
// Press bed with the column at its back.
s.halo(BED, 0);
s.solid(slabOf(BED, 0, BED_H, s.P, 6, 0.8));
screws(
	s,
	[
		[BED.x + 6, BED.y + BED.d - 6],
		[BED.x + BED.w - 6, BED.y + BED.d - 6],
	],
	BED_H,
	1.4
);
s.solid(slabOf(COLUMN, BED_H, ARM_Z - BED_H, s.P, 3, 0.6));
// The draft sheet under the head, its first lines already set.
const SHEET = { x: -24, y: -18, w: 48, d: 44, r: 1.5 };
s.solid(slabOf(SHEET, BED_H, 1, s.P, 2), { crease: "none" });
for (const [i, span] of [34, 28, 20].entries()) {
	const y = SHEET.y + 30 + i * 5;
	s.line(lineOnTop([SHEET.x + 6, y], [SHEET.x + 6 + span, y], BED_H + 1, s.P), {
		tone: i === 0 ? "mid" : "lo",
	});
}
// Head: the template plate on the ram, the ram, then the arm above.
const STAMP = { x: HEAD[0] - 15, y: HEAD[1] - 12, w: 30, d: 22, r: 2 };
s.solid(slabOf(STAMP, STAMP_Z, 4, s.P, 3), { lit: true });
s.solid(
	slabOf(
		{ ...STAMP, x: STAMP.x + 2, y: STAMP.y + 2, w: 26, d: 18 },
		STAMP_Z + 4,
		6,
		s.P,
		3,
		0.6
	),
	{
		tone: "lo",
	}
);
s.solid(
	cylinder(HEAD[0], HEAD[1], 3.5, STAMP_Z + 10, ARM_Z - STAMP_Z - 10, s.P, 20)
);
const ARM = { x: -9, y: -38, w: 18, d: 50, r: 3 };
s.solid(slabOf(ARM, ARM_Z, ARM_H, s.P, 4, 0.8));
knob(s, [HEAD[0], HEAD[1]], ARM_Z + ARM_H, 5, 5);
lamp(s, [0, -31], ARM_Z + ARM_H, { radius: 1.8 });
// Out tray of finished drafts.
const TRAY = { x: 50, y: -24, w: 36, d: 48, r: 3 };
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 4, s.P, 4, 0.6), { tone: "lo" });
for (let i = 0; i < 3; i++) {
	const sheet = { x: TRAY.x + 4 + i, y: TRAY.y + 4 - i, w: 28, d: 40, r: 1 };
	s.solid(slabOf(sheet, 4 + i * 1.6, 1.6, s.P, 2), { crease: "none" });
}
for (const [i, span] of [18, 14, 18, 10].entries()) {
	const y = TRAY.y + 10 + i * 6;
	s.line(lineOnTop([TRAY.x + 12, y], [TRAY.x + 12 + span, y], 8.8, s.P), {
		tone: "lo",
	});
}

export const drawing = cardDrawing(s);
