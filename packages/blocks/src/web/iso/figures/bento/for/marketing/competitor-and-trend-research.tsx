import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Competitor and trend research: a periscope. Its head rises above the bench
 * to look out at the web through its window (the lit glass); what it finds
 * comes down the tube and leaves the base as a short brief in the tray.
 */

const PLATE = { x: -88, y: -54, w: 176, d: 108, r: 8 };
const BASE = { x: -66, y: -40, w: 58, d: 58, r: 5 };
const BASE_H = 16;
const TUBE: [number, number] = [-40, -14];
const TUBE_TOP = 58;
const HEAD = { x: -52, y: -26, w: 26, d: 24, r: 3 };
const HEAD_H = 18;
const TRAY = { x: 14, y: -14, w: 52, d: 46, r: 3 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[HEAD.x, HEAD.y, TUBE_TOP + HEAD_H],
]);

benchPlate(s, PLATE);
// Base with a focus knob and a crank collar.
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BASE, 4), BASE_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[BASE.x + 8, BASE.y + BASE.d - 8],
		[BASE.x + BASE.w - 8, BASE.y + 8],
	],
	BASE_H,
	1.4
);
s.line(faceRect(s, "y", BASE.y + BASE.d, BASE.x + 34, BASE.x + 50, 4, 10), {
	tone: "lo",
});
// Tube with two collars.
s.solid(cylinder(TUBE[0], TUBE[1], 12, BASE_H, 3, s.P, 32), { tone: "lo" });
s.solid(
	cylinder(TUBE[0], TUBE[1], 8, BASE_H + 3, TUBE_TOP - BASE_H - 3, s.P, 32)
);
s.line(ring(TUBE[0], TUBE[1], 8, BASE_H + 20, s.P, 32), { tone: "lo" });
s.solid(cylinder(TUBE[0], TUBE[1], 10, TUBE_TOP - 6, 4, s.P, 32), {
	tone: "lo",
});
knob(s, [BASE.x + 46, BASE.y + 44], BASE_H, 5, 6);
// Head: a box turned to look out along +x, its glass on the near face.
s.solid(slabOf(HEAD, TUBE_TOP - 2, HEAD_H, s.P, 4, 0.8));
s.solid(
	slabOf(
		{ x: HEAD.x + HEAD.w, y: HEAD.y + 3, w: 6, d: HEAD.d - 6, r: 1 },
		TUBE_TOP + 1,
		HEAD_H - 6,
		s.P,
		2,
		0.4
	),
	{ tone: "lo" }
);
s.solid(
	slabOf(
		{ x: HEAD.x + HEAD.w + 6, y: HEAD.y + 5, w: 1.4, d: HEAD.d - 10, r: 0.4 },
		TUBE_TOP + 3,
		HEAD_H - 9,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
// The brief: a short stack of sheets in the out tray.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 5, s.P, 4, 0.6), { tone: "lo" });
const sheet = insetPlan(TRAY, 6);
s.solid(slabOf(sheet, 5, 3, s.P, 3), { crease: "none" });
for (const [i, length] of [30, 22, 26].entries()) {
	const y = sheet.y + 8 + i * 7;
	s.line(lineOnTop([sheet.x + 5, y], [sheet.x + 5 + length, y], 8, s.P), {
		tone: i === 0 ? "mid" : "lo",
	});
}

export const drawing = cardDrawing(s);
