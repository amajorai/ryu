import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceLine, faceRect, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Trigger events: a mailbox on a post. Events from connected apps arrive as
 * letters stacked in the open in-tray beside it; the raised flag (the lit
 * part) says mail is waiting until your service comes to collect it.
 */

const PLATE = { x: -84, y: -52, w: 168, d: 104, r: 8 };
const POST = { x: -38, y: -12, w: 10, d: 10, r: 1 };
const BOX = { x: -54, y: -26, w: 44, d: 38, r: 4 };
const BOX_Z = 34;
const BOX_H = 26;
const TRAY = { x: 14, y: -20, w: 52, d: 40, r: 3 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-10, -20, 82]]);

benchPlate(s, PLATE);
// Post on a foot plate, the box on top.
const foot = { x: -46, y: -20, w: 26, d: 26, r: 2 };
s.halo(foot, 0);
s.solid(slabOf(foot, 0, 3, s.P, 3, 0.4), { tone: "lo" });
screws(
	s,
	[
		[foot.x + 4, foot.y + 4],
		[foot.x + foot.w - 4, foot.y + foot.d - 4],
	],
	3,
	1.2
);
s.solid(slabOf(POST, 3, BOX_Z - 3, s.P, 2));
s.solid(slabOf(BOX, BOX_Z, BOX_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BOX, 4), BOX_Z + BOX_H, s.P, 4), {
	tone: "faint",
});
const front = BOX.y + BOX.d;
s.line(
	faceRect(s, "y", front, BOX.x + 6, BOX.x + BOX.w - 6, BOX_Z + 4, BOX_Z + 22),
	{
		tone: "lo",
	}
);
s.line(faceLine(s, "y", front, BOX.x + 14, BOX.x + 30, BOX_Z + 17), {
	tone: "mid",
});
s.solid(cylinder(BOX.x + BOX.w / 2, front + 1, 2, BOX_Z + 8, 3, s.P, 16), {
	tone: "lo",
});
// Flag on the near (+x) side, swung up: mail is waiting.
const side = BOX.x + BOX.w;
s.solid(
	slabOf(
		{ x: side, y: BOX.y + 8, w: 3, d: 12, r: 0.5 },
		BOX_Z + 34,
		10,
		s.P,
		2
	),
	{ lit: true }
);
s.solid(
	slabOf({ x: side, y: BOX.y + 20, w: 3, d: 4, r: 0.5 }, BOX_Z + 8, 36, s.P, 2),
	{ lit: true }
);
// In-tray of waiting letters.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 3, s.P, 4, 0.4), { tone: "lo" });
s.solid(slabOf({ x: TRAY.x, y: TRAY.y, w: TRAY.w, d: 3, r: 1 }, 3, 12, s.P, 2));
s.solid(slabOf({ x: TRAY.x, y: TRAY.y, w: 3, d: TRAY.d, r: 1 }, 3, 12, s.P, 2));
for (let i = 0; i < 4; i++) {
	const letter = {
		x: TRAY.x + 7 + (i % 2) * 2,
		y: TRAY.y + 6 + (i % 2),
		w: 40,
		d: 28,
		r: 1,
	};
	s.solid(slabOf(letter, 3 + i * 2.4, 2.4, s.P, 2), { crease: "none" });
}
s.line(
	planOutline(
		{ x: TRAY.x + 13, y: TRAY.y + 10, w: 28, d: 12, r: 0 },
		12.6,
		s.P,
		1
	),
	{ tone: "faint" }
);

export const drawing = cardDrawing(s);
