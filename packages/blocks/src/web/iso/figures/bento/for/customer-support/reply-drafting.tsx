import {
	boxCorners,
	cylinder,
	knurl,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	byDepth,
	faceRules,
	lamp,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Reply drafting: a typewriter on the bench. The ticket waits in the
 * in-tray beside it; the reply rolls up out of the carriage on a fresh sheet
 * (the lit sheet), typed but not yet torn off, ready for someone to review.
 */

const PLATE = { x: -96, y: -52, w: 192, d: 104, r: 8 };
const BODY = { x: -52, y: -26, w: 104, d: 54, r: 6 };
const BODY_H = 18;
const CARRIAGE = { x: -60, y: -30, w: 120, d: 16, r: 4 };
const CARRIAGE_TOP = BODY_H + 12;
const SHEET = { x: -28, y: -24, w: 56, d: 2, r: 0 };
const SHEET_TOP = CARRIAGE_TOP + 44;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, SHEET.y, SHEET_TOP],
]);

function platenKnob(x: number) {
	s.solid(cylinder(x, CARRIAGE.y + 8, 6, BODY_H + 2, 8, s.P, 28), {
		tone: "lo",
	});
	s.line(knurl(x, CARRIAGE.y + 8, 6, BODY_H + 2, BODY_H + 10, 24, s.P), {
		tone: "lo",
	});
}

benchPlate(s, PLATE);
// The ticket in its in-tray at the back right.
const tray = { x: 60, y: -42, w: 28, d: 36, r: 3 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 5, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf({ x: 64, y: -37, w: 20, d: 26, r: 1 }, 5, 2, s.P, 2));
// Body and carriage.
s.halo(BODY, 0);
s.solid(slabOf(BODY, 0, BODY_H, s.P, 6, 1));
platenKnob(CARRIAGE.x - 5);
s.solid(slabOf(CARRIAGE, BODY_H, CARRIAGE_TOP - BODY_H, s.P, 4, 0.8), {
	tone: "lo",
});
// The drafted reply standing up out of the carriage.
s.solid(slabOf(SHEET, CARRIAGE_TOP, SHEET_TOP - CARRIAGE_TOP, s.P, 1), {
	lit: true,
});
faceRules(
	s,
	"y",
	SHEET.y + SHEET.d,
	SHEET.x + 6,
	SHEET_TOP - 8,
	[34, 44, 40, 44, 22],
	6
);
platenKnob(CARRIAGE.x + CARRIAGE.w + 5);
lamp(s, [BODY.x + BODY.w - 9, BODY.y + 24], BODY_H, { radius: 1.8 });
// Two rows of keys on the front of the body.
const keys: [number, number][] = [];
for (const [row, y] of [4, 16].entries()) {
	for (let i = 0; i < 6; i++) {
		keys.push([-38 + i * 14 + row * 5, y]);
	}
}
for (const [x, y] of byDepth(keys, s, BODY_H)) {
	s.solid(cylinder(x, y, 4, BODY_H, 3, s.P, 20));
}
screws(
	s,
	[
		[BODY.x + 6, BODY.y + BODY.d - 6],
		[BODY.x + BODY.w - 6, BODY.y + BODY.d - 6],
	],
	BODY_H,
	1.4
);

export const drawing = cardDrawing(s);
