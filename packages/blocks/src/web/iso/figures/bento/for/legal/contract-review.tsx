import {
	boxCorners,
	insetPlan,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Contract review: a reading gantry over a contract in a tray. The gantry
 * rides its rails line by line, checking the page against the playbook binder
 * beside it, and has stopped over the risky clause (the lit bar).
 */

const PLATE = { x: -98, y: -56, w: 196, d: 112, r: 8 };
const TRAY = { x: -82, y: -38, w: 104, d: 76, r: 4 };
const SHEET = insetPlan(TRAY, 6);
const TRAY_H = 5;
const TOP = TRAY_H + 0.2;
const GANTRY_X = -18;
const RAIL_H = 3;
const POST_H = 36;
const BAR_H = 6;
const FLAG_ROW = 4;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[GANTRY_X, 0, POST_H + BAR_H + 9],
]);

const rowY = (i: number) => SHEET.y + 8 + i * 8.4;
const flagY = rowY(FLAG_ROW);

function rail(y: number) {
	s.solid(slabOf({ x: -88, y, w: 116, d: 6, r: 1.5 }, 0, RAIL_H, s.P, 3), {
		tone: "lo",
	});
}

function post(y: number) {
	const plan = { x: GANTRY_X - 4, y, w: 8, d: 6, r: 1.5 };
	s.solid(slabOf(plan, RAIL_H, POST_H - RAIL_H, s.P, 3, 0.4));
}

benchPlate(s, PLATE);
rail(-50);
post(-50);
// The contract: a sheet of rule lines in a shallow tray.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H - 1, s.P, 6, 0.8));
s.solid(slabOf(SHEET, TRAY_H - 1, 1.2, s.P, 3), { crease: "none" });
const lengths = [70, 58, 76, 48, 0, 66, 40];
lengths.forEach((length, i) => {
	if (i !== FLAG_ROW) {
		s.line(
			lineOnTop(
				[SHEET.x + 6, rowY(i)],
				[SHEET.x + 6 + length, rowY(i)],
				TOP,
				s.P
			),
			{ tone: i === 0 ? "mid" : "lo" }
		);
	}
});
s.solid(
	slabOf(
		{ x: SHEET.x + 6, y: flagY - 2.6, w: 72, d: 5.2, r: 1 },
		TOP,
		1.4,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
// The playbook: a thick binder, covers proud of the page block, with
// index tabs sticking out of the page edge.
const BINDER = { x: 38, y: -36, w: 46, d: 56, r: 3 };
const PAGES = {
	x: BINDER.x + 2,
	y: BINDER.y + 2,
	w: BINDER.w - 4,
	d: BINDER.d - 4,
	r: 1.5,
};
const COVER = 2.2;
const BINDER_H = 18;
s.halo(BINDER, 0);
s.solid(slabOf(BINDER, 0, COVER, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(PAGES, COVER, BINDER_H - 2 * COVER, s.P, 2), {
	crease: "none",
});
faceRules(
	s,
	"x",
	PAGES.x + PAGES.w,
	PAGES.y + 3,
	13,
	[PAGES.d - 6, PAGES.d - 6, PAGES.d - 6, PAGES.d - 6],
	2.6
);
for (const [y, z] of [
	[PAGES.y + 8, 4],
	[PAGES.y + 22, 7.5],
	[PAGES.y + 36, 11],
] as const) {
	s.solid(
		slabOf({ x: PAGES.x + PAGES.w, y, w: 5, d: 9, r: 0.8 }, z, 1.2, s.P, 2),
		{
			tone: "lo",
		}
	);
}
s.solid(slabOf(BINDER, BINDER_H - COVER, COVER, s.P, 4, 0.6));
s.line(
	lineOnTop(
		[BINDER.x + 8, BINDER.y],
		[BINDER.x + 8, BINDER.y + BINDER.d],
		BINDER_H,
		s.P
	),
	{ tone: "lo" }
);
// Near rail and post, then the bridge and its reading carriage.
rail(44);
post(44);
const BAR = { x: GANTRY_X - 5, y: -51, w: 10, d: 102, r: 2 };
s.solid(slabOf(BAR, POST_H, BAR_H, s.P, 3, 0.6));
screws(
	s,
	[
		[GANTRY_X, -46],
		[GANTRY_X, 46],
	],
	POST_H + BAR_H,
	1.3
);
const CARRIAGE = { x: GANTRY_X - 8, y: flagY - 8, w: 16, d: 16, r: 2 };
s.solid(slabOf(CARRIAGE, POST_H + BAR_H, 6, s.P, 3, 0.6), { tone: "lo" });
knob(s, [GANTRY_X, flagY], POST_H + BAR_H + 6, 3.4, 3);

export const drawing = cardDrawing(s);
