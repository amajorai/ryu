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
 * Vendor and invoice processing: a reading sorter. Invoices ride a belt under
 * the reader hood, which extracts their fields and checks them against the
 * order. At the end a diverter flap sends matched invoices to the back tray
 * and the one that disagrees (lit) to the front exceptions tray, beside the
 * approval stamp waiting on its ink pad.
 */

const PLATE = { x: -104, y: -50, w: 208, d: 100, r: 8 };
const BELT = { x: -94, y: -10, w: 120, d: 20, r: 3 };
const BELT_H = 6;
const HOOD_X = -52;
const HOOD_H = 30;
const BACK_TRAY = { x: 38, y: -42, w: 54, d: 34, r: 3 };
const FRONT_TRAY = { x: 38, y: 6, w: 54, d: 36, r: 3 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[HOOD_X, -16, HOOD_H + 6],
	[1, 33, 26],
]);

function tray(plan: typeof BACK_TRAY, sheets: number, lit: boolean) {
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, 5, s.P, 4, 0.6), { tone: "lo" });
	const sheet = insetPlan(plan, 7);
	for (let i = 0; i < sheets; i++) {
		s.solid(slabOf(sheet, 5 + i * 1.6, 1.6, s.P, 3), {
			lit: lit && i === sheets - 1,
			crease: "none",
		});
	}
	const top = 5 + sheets * 1.6;
	for (const [i, span] of [24, 16, 20].entries()) {
		const y = sheet.y + 6 + i * 6;
		s.line(lineOnTop([sheet.x + 5, y], [sheet.x + 5 + span, y], top, s.P), {
			tone: "lo",
		});
	}
}

function invoice(cx: number) {
	const plan = { x: cx - 8, y: -7, w: 16, d: 14, r: 1 };
	s.solid(slabOf(plan, BELT_H, 2, s.P, 2), { crease: "none" });
	s.line(lineOnTop([cx - 5, -3], [cx + 3, -3], BELT_H + 2, s.P), {
		tone: "lo",
	});
	s.line(lineOnTop([cx - 5, 1], [cx + 1, 1], BELT_H + 2, s.P), { tone: "lo" });
}

benchPlate(s, PLATE);
tray(BACK_TRAY, 3, false);
// Far leg of the reader hood, behind the belt.
s.solid(
	slabOf({ x: HOOD_X - 12, y: -17, w: 24, d: 5, r: 1 }, 0, HOOD_H, s.P, 2)
);
// The belt, its slats and the invoices riding it.
s.halo(BELT, 0);
s.solid(slabOf(BELT, 0, BELT_H, s.P, 4, 0.6), { tone: "lo" });
for (let x = BELT.x + 8; x < BELT.x + BELT.w - 4; x += 10) {
	s.line(lineOnTop([x, BELT.y + 2], [x, BELT.y + BELT.d - 2], BELT_H, s.P), {
		tone: "faint",
	});
}
invoice(-80);
invoice(-14);
// Near leg and roof of the reader hood, with its scan lamp.
s.solid(
	slabOf({ x: HOOD_X - 12, y: 12, w: 24, d: 5, r: 1 }, 0, HOOD_H, s.P, 2)
);
const ROOF = { x: HOOD_X - 14, y: -18, w: 28, d: 36, r: 3 };
s.solid(slabOf(ROOF, HOOD_H, 6, s.P, 4, 0.6));
s.line(planOutline(insetPlan(ROOF, 4), HOOD_H + 6, s.P, 3), { tone: "faint" });
lamp(s, [HOOD_X, -6], HOOD_H + 6, { radius: 2.2 });
screws(
	s,
	[
		[HOOD_X - 8, 10],
		[HOOD_X + 8, 10],
	],
	HOOD_H + 6,
	1.2
);
// Diverter at the end of the belt: pivot post and flap, thrown to the front.
s.solid(cylinder(31, -6, 3, 0, 14, s.P, 20), { tone: "lo" });
s.solid(slabOf({ x: 29, y: -4, w: 4, d: 14, r: 1 }, 2, 10, s.P, 2));
// Divider between the matched and the exceptions trays.
s.solid(slabOf({ x: 38, y: -6, w: 54, d: 4, r: 1 }, 0, 10, s.P, 2), {
	tone: "lo",
});
tray(FRONT_TRAY, 1, true);
// Approval stamp on its ink pad.
const PAD = { x: -16, y: 20, w: 34, d: 26, r: 3 };
s.halo(PAD, 0);
s.solid(slabOf(PAD, 0, 4, s.P, 4, 0.5), { tone: "lo" });
s.solid(slabOf({ x: -10, y: 24, w: 22, d: 18, r: 2 }, 4, 6, s.P, 3, 0.5));
s.solid(cylinder(1, 33, 3, 10, 10, s.P, 20));
s.solid(cylinder(1, 33, 6, 20, 6, s.P, 28, 0.8));

export const drawing = cardDrawing(s);
