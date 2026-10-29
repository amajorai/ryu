import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Approval points: a sign-off desk. Steps wait as sheets in the in-tray until
 * the rubber stamp comes down on the top one (the lit handle is your hand on
 * it); signed sheets go on the spike, and the ink pad sits ready beside.
 */

const PLATE = { x: -86, y: -56, w: 172, d: 104, r: 8 };
const TRAY = { x: -50, y: -40, w: 84, d: 74, r: 3 };
const TRAY_H = 4;
const SHEET = insetPlan(TRAY, 4);
const SHEET_H = 1.6;
const SHEETS = 4;
const STAMP: [number, number] = [-8, -3];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[STAMP[0], STAMP[1], 62],
]);

benchPlate(s, PLATE);
// The spike for signed sheets, at the front left.
s.halo({ x: -80, y: 20, w: 26, d: 26, r: 13 }, 0);
s.solid(cylinder(-67, 33, 12, 0, 4, s.P, 32, 0.4), { tone: "lo" });
s.solid(slabOf({ x: -78, y: 24, w: 22, d: 18, r: 1 }, 4, 1.4, s.P, 2));
s.solid(slabOf({ x: -76, y: 25, w: 22, d: 18, r: 1 }, 5.4, 1.4, s.P, 2));
s.solid(slabOf({ x: -78, y: 23, w: 22, d: 18, r: 1 }, 6.8, 1.4, s.P, 2));
s.solid(cylinder(-67, 33, 1.4, 8.2, 26, s.P, 12));
// The in-tray and its stack of waiting sheets.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 4, 0.6), { tone: "lo" });
for (let index = 0; index < SHEETS; index++) {
	const shift = index % 2 === 0 ? 0 : 1.2;
	s.solid(
		slabOf(
			{ ...SHEET, x: SHEET.x + shift, y: SHEET.y - shift },
			TRAY_H + index * SHEET_H,
			SHEET_H,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
const paperTop = TRAY_H + SHEETS * SHEET_H;
// The rubber stamp, pressed down on the top sheet.
const foot = { x: STAMP[0] - 17, y: STAMP[1] - 13, w: 34, d: 26, r: 2 };
s.halo(foot, paperTop);
s.solid(slabOf(foot, paperTop, 3, s.P, 3), { tone: "lo" });
s.solid(slabOf(insetPlan(foot, 1), paperTop + 3, 6, s.P, 3, 0.6));
s.line(planOutline(insetPlan(foot, 4), paperTop + 9, s.P, 2), {
	tone: "faint",
});
const neckZ = paperTop + 9;
s.solid(cylinder(STAMP[0], STAMP[1], 4, neckZ, 18, s.P, 20));
s.solid(cylinder(STAMP[0], STAMP[1], 7, neckZ + 18, 2.4, s.P, 28), {
	tone: "lo",
});
const gripZ = neckZ + 20.4;
s.solid(cylinder(STAMP[0], STAMP[1], 10, gripZ, 11, s.P, 36, 1.2), {
	lit: true,
});
s.line(knurl(STAMP[0], STAMP[1], 10, gripZ + 1, gripZ + 10, 30, s.P), {
	tone: "lo",
});
s.line(ring(STAMP[0], STAMP[1], 4, gripZ + 11, s.P, 20), { tone: "mid" });
// The ink pad tin, lid open behind it.
const pad = { x: 44, y: -16, w: 34, d: 28, r: 3 };
s.solid(slabOf({ x: 44, y: -40, w: 34, d: 22, r: 3 }, 0, 2, s.P, 3), {
	tone: "lo",
});
s.halo(pad, 0);
s.solid(slabOf(pad, 0, 7, s.P, 4, 0.6));
s.solid(slabOf(insetPlan(pad, 4), 7, 0.6, s.P, 3), { tone: "lo" });

export const drawing = cardDrawing(s);
