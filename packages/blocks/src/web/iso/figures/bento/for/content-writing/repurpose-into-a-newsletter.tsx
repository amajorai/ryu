import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	sideRing,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	knob,
	lamp,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Repurpose into a newsletter: a letter folder. The long article lies on the
 * feed table and runs into the folding rollers; out the other side drops a
 * short folded letter (the lit sheet), the same paper in a smaller format.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const TABLE = { x: -86, y: -28, w: 66, d: 52, r: 3 };
const TABLE_H = 14;
const SHEET = { x: -82, y: -22, w: 66, d: 40, r: 0.6 };
const BODY = { x: -18, y: -36, w: 52, d: 66, r: 5 };
const BODY_H = 32;
const TRAY = { x: 44, y: -22, w: 44, d: 46, r: 3 };
const TRAY_H = 4;
const LETTER = { x: 50, y: -14, w: 32, d: 30, r: 1 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[BODY.x, BODY.y, BODY_H + 8],
]);

benchPlate(s, PLATE);
// Feed table with the long article on it, running into the folder.
s.halo(TABLE, 0);
s.solid(slabOf(TABLE, 0, TABLE_H, s.P, 4, 0.8), { tone: "lo" });
s.solid(slabOf(SHEET, TABLE_H, 1.2, s.P, 2), { crease: "none" });
for (let row = 0; row < 6; row++) {
	const y = SHEET.y + 6 + row * 6;
	s.line(
		lineOnTop([SHEET.x + 6, y], [SHEET.x + SHEET.w - 4, y], TABLE_H + 1.2, s.P),
		{
			tone: "faint",
		}
	);
}
// Folder body: the roller ends show on its front face.
s.halo(BODY, 0);
s.solid(slabOf(BODY, 0, BODY_H, s.P, 6, 1.2));
s.line(planOutline(insetPlan(BODY, 5), BODY_H, s.P, 4), { tone: "faint" });
const front = BODY.y + BODY.d;
for (const x of [-4, 14]) {
	s.line(sideRing([x, front, 18], 6, "y", s.P, 24), { tone: "mid" });
	s.line(sideRing([x, front, 18], 1.6, "y", s.P, 12), { tone: "lo" });
}
s.line(faceRect(s, "x", BODY.x + BODY.w, -14, 14, 6, 9), { tone: "mid" });
knob(s, [BODY.x + 14, BODY.y + 14], BODY_H, 4, 5);
lamp(s, [BODY.x + BODY.w - 10, BODY.y + 10], BODY_H, { radius: 1.8 });
// Output tray with the folded letter.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(LETTER, TRAY_H, 3, s.P, 2, 0.3), { lit: true, crease: "none" });
s.line(
	lineOnTop(
		[LETTER.x, LETTER.y + 15],
		[LETTER.x + LETTER.w, LETTER.y + 15],
		TRAY_H + 3,
		s.P
	),
	{ tone: "mid" }
);
screws(
	s,
	[
		[TRAY.x + 5, TRAY.y + TRAY.d - 4],
		[TRAY.x + TRAY.w - 5, TRAY.y + 4],
	],
	TRAY_H,
	1.2
);

export const drawing = cardDrawing(s);
