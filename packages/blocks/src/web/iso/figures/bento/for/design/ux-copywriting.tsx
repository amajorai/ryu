import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, faceRules, knob } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * UX copywriting: a typewriter. The tone-of-voice guide is the carriage it
 * types through; the sheet rolling out of the platen (the lit part) carries
 * the drafted microcopy as short lines.
 */

const PLATE = { x: -84, y: -56, w: 168, d: 112, r: 8 };
const BODY = { x: -50, y: -30, w: 100, d: 62, r: 6 };
const BODY_H = 14;
const CARRIAGE = { x: -58, y: -38, w: 116, d: 18, r: 4 };
const CARRIAGE_H = 8;
const PLATEN = { x: -52, y: -36, w: 104, d: 12, r: 6 };
const PLATEN_Z = BODY_H + CARRIAGE_H;
const SHEET = { x: -30, y: -31, w: 60, d: 1.2, r: 0 };
const SHEET_TOP = 62;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, SHEET.y, SHEET_TOP + 2],
]);

benchPlate(s, PLATE);
s.halo(BODY, 0);
s.solid(slabOf(BODY, 0, BODY_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BODY, 4), BODY_H, s.P, 4), { tone: "faint" });
// Carriage and platen roller across the back.
s.solid(slabOf(CARRIAGE, BODY_H, CARRIAGE_H, s.P, 4, 0.6));
knob(s, [CARRIAGE.x + 4, CARRIAGE.y + 9], PLATEN_Z, 3.5, 6);
s.solid(slabOf(PLATEN, PLATEN_Z, 7, s.P, 8), { tone: "lo" });
// The sheet stands out of the roller, its copy as rule lines.
s.solid(slabOf(SHEET, PLATEN_Z + 4, SHEET_TOP - PLATEN_Z - 4, s.P, 1), {
	lit: true,
	crease: "none",
});
faceRules(
	s,
	"y",
	SHEET.y + SHEET.d,
	SHEET.x + 7,
	SHEET_TOP - 8,
	[38, 26, 42, 18],
	6
);
knob(s, [CARRIAGE.x + CARRIAGE.w - 4, CARRIAGE.y + 9], PLATEN_Z, 3.5, 6);
// Paper guide bar in front of the platen.
s.solid(slabOf({ x: -40, y: -23, w: 80, d: 3, r: 1 }, PLATEN_Z, 2, s.P, 2), {
	tone: "lo",
});
// Three rows of round keys and a space bar.
const keys = byDepth(
	[0, 1, 2].flatMap((row) =>
		[0, 1, 2, 3, 4, 5, 6, 7].map((column): [number, number] => [
			-38 + column * 10.4 + row * 3,
			-8 + row * 10,
		])
	),
	s,
	BODY_H
);
for (const [x, y] of keys) {
	s.solid(cylinder(x, y, 1.4, BODY_H, 3, s.P, 12));
	s.solid(cylinder(x, y, 3.6, BODY_H + 3, 2, s.P, 24, 0.4));
}
s.solid(slabOf({ x: -22, y: 22, w: 44, d: 5, r: 2 }, BODY_H, 3, s.P, 3));

export const drawing = cardDrawing(s);
