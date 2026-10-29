import {
	boxCorners,
	circleRing,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ringSeam,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Competitive scans: a periscope on the bench. Its head (with the lit lens)
 * looks out over the wall at a competitor's changelog; what it sees comes
 * down the tube to the eyepiece and is written up as a short brief on the
 * clipboard in front, sources listed underneath.
 */

const PLATE = { x: -90, y: -50, w: 180, d: 100, r: 8 };
const BASE = { x: -60, y: -32, w: 52, d: 50, r: 4 };
const BASE_H = 10;
const TUBE: [number, number] = [-34, -8];
const TUBE_TOP = 58;
const HEAD = { x: -50, y: -22, w: 32, d: 28, r: 3 };
const HEAD_H = 16;
const BOARD = { x: 14, y: -30, w: 58, d: 64, r: 3 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[HEAD.x, HEAD.y, TUBE_TOP + HEAD_H + 2],
]);

benchPlate(s, PLATE);
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 4, 1));
s.line(planOutline(insetPlan(BASE, 4), BASE_H, s.P, 3), { tone: "faint" });
screws(
	s,
	[
		[BASE.x + 7, BASE.y + 7],
		[BASE.x + BASE.w - 7, BASE.y + 7],
	],
	BASE_H,
	1.3
);
// Tube with two collars.
s.solid(cylinder(TUBE[0], TUBE[1], 11, BASE_H, 3, s.P, 32, 0.6), {
	tone: "lo",
});
s.solid(
	cylinder(TUBE[0], TUBE[1], 8, BASE_H + 3, TUBE_TOP - BASE_H - 3, s.P, 32)
);
s.line(ringSeam(circleRing(TUBE[0], TUBE[1], 8, 32), 30, s.P), { tone: "lo" });
s.line(ringSeam(circleRing(TUBE[0], TUBE[1], 8, 32), 46, s.P), { tone: "lo" });
// Head box at the top; its window faces out along +x.
s.solid(slabOf(HEAD, TUBE_TOP, HEAD_H, s.P, 3, 0.8));
s.line(
	faceRect(
		s,
		"x",
		HEAD.x + HEAD.w,
		HEAD.y + 4,
		HEAD.y + HEAD.d - 4,
		TUBE_TOP + 3,
		TUBE_TOP + HEAD_H - 3
	),
	{
		tone: "lo",
	}
);
s.solid(
	slabOf(
		{ x: HEAD.x + HEAD.w, y: HEAD.y + 6, w: 1.6, d: HEAD.d - 12, r: 0 },
		TUBE_TOP + 5,
		HEAD_H - 10,
		s.P,
		1
	),
	{ lit: true, crease: "none" }
);
// Eyepiece hood on the near side of the tube.
s.solid(
	slabOf(
		{ x: TUBE[0] - 7, y: TUBE[1] + 4, w: 14, d: 12, r: 2 },
		20,
		12,
		s.P,
		2,
		0.4
	)
);
s.line(faceRect(s, "y", TUBE[1] + 16, TUBE[0] - 4, TUBE[0] + 4, 23, 29), {
	tone: "mid",
});
knob(s, [BASE.x + BASE.w - 10, BASE.y + BASE.d - 10], BASE_H, 3.5, 4);
// Clipboard with the brief: heading, summary rules, source list.
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, 2, s.P, 3, 0.4), { tone: "lo" });
const sheet = {
	x: BOARD.x + 4,
	y: BOARD.y + 8,
	w: BOARD.w - 8,
	d: BOARD.d - 12,
	r: 0.5,
};
s.solid(slabOf(sheet, 2, 1, s.P, 1), { crease: "none" });
s.solid(
	slabOf({ x: BOARD.x + 16, y: BOARD.y + 3, w: 26, d: 9, r: 1.5 }, 3, 3, s.P, 2)
);
const top = 3;
s.line(
	lineOnTop([sheet.x + 5, sheet.y + 8], [sheet.x + 32, sheet.y + 8], top, s.P),
	{ tone: "mid" }
);
for (const [i, w] of [36, 40, 30, 38].entries()) {
	const y = sheet.y + 15 + i * 4.5;
	s.line(lineOnTop([sheet.x + 5, y], [sheet.x + 5 + w, y], top, s.P), {
		tone: "faint",
	});
}
for (let i = 0; i < 3; i++) {
	const y = sheet.y + 38 + i * 4.5;
	s.line(lineOnTop([sheet.x + 5, y], [sheet.x + 7, y], top, s.P), {
		tone: "mid",
	});
	s.line(lineOnTop([sheet.x + 10, y], [sheet.x + 30, y], top, s.P), {
		tone: "lo",
	});
}

export const drawing = cardDrawing(s);
