import {
	boxCorners,
	cylinder,
	lineOnTop,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceLine,
	faceRect,
	faceRules,
	knob,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * E-ink desk display: a paper-white panel standing in a weighted foot. The
 * summary rolls up under a top roller like a ticker roll; the newest line (the lit
 * bar) is the one just written. A speaker grille in the foot lets it chat.
 */

const PLATE = { x: -96, y: -46, w: 192, d: 92, r: 8 };
const FOOT = { x: -70, y: -22, w: 140, d: 30, r: 4 };
const FOOT_H = 10;
const PANEL = { x: -62, y: -14, w: 124, d: 7, r: 2 };
const PANEL_H = 70;
const FACE = PANEL.y + PANEL.d;
const Z0 = FOOT_H;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, -14, Z0 + PANEL_H + 8],
]);

benchPlate(s, PLATE);
// Weighted foot with a slot the panel stands in.
s.halo(FOOT, 0);
s.solid(slabOf(FOOT, 0, FOOT_H, s.P, 4, 0.8));
s.line(
	lineOnTop(
		[FOOT.x + 6, FOOT.y + 4],
		[FOOT.x + FOOT.w - 6, FOOT.y + 4],
		FOOT_H,
		s.P
	),
	{
		tone: "faint",
	}
);
// The panel.
s.solid(slabOf(PANEL, Z0, PANEL_H, s.P, 3, 0.8));
// Rollers at top and bottom of the screen, the roll running between them.
const ROLL_Z = Z0 + PANEL_H;
s.solid(
	slabOf(
		{ x: PANEL.x + 4, y: PANEL.y + 1, w: PANEL.w - 8, d: 5, r: 2.5 },
		ROLL_Z,
		4,
		s.P,
		4
	),
	{ tone: "lo" }
);
for (const x of [PANEL.x + 2, PANEL.x + PANEL.w - 2]) {
	s.solid(cylinder(x, PANEL.y + 3.5, 3, ROLL_Z, 5, s.P, 16));
}
s.line(
	faceRect(
		s,
		"y",
		FACE,
		PANEL.x + 6,
		PANEL.x + PANEL.w - 6,
		Z0 + 6,
		Z0 + PANEL_H - 6
	),
	{
		tone: "mid",
	}
);
faceRules(
	s,
	"y",
	FACE,
	PANEL.x + 14,
	Z0 + PANEL_H - 22,
	[70, 52, 84, 40, 64, 30],
	7
);
s.line(
	faceLine(
		s,
		"y",
		FACE,
		PANEL.x + 10,
		PANEL.x + PANEL.w - 10,
		Z0 + PANEL_H - 14
	),
	{
		tone: "faint",
	}
);
// The newest line, just written: a raised lit bar at the top of the roll.
s.solid(
	slabOf(
		{ x: PANEL.x + 14, y: FACE, w: 60, d: 1.4, r: 0.6 },
		Z0 + PANEL_H - 13,
		3.4,
		s.P,
		2
	),
	{ lit: true }
);
// Speaker grille and a knob on the foot's front.
const grille: [number, number, number][] = [];
for (let row = 0; row < 2; row++) {
	for (let col = 0; col < 12; col++) {
		grille.push([FOOT.x + 40 + col * 5, FOOT.y + FOOT.d, 3.5 + row * 3.5]);
	}
}
s.dots(grille.map(s.at), { size: 0.9, tone: "hi" });
knob(s, [FOOT.x + FOOT.w - 10, FOOT.y + FOOT.d - 8], FOOT_H, 3.4, 3.4);
screws(s, [[FOOT.x + 8, FOOT.y + FOOT.d - 8]], FOOT_H, 1.4);
screws(
	s,
	[
		[-84, 34],
		[84, -34],
	],
	0,
	1.6
);

export const drawing = cardDrawing(s);
