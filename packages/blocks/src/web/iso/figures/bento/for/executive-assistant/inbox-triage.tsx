import {
	boxCorners,
	corners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Inbox triage: a tower of three letter trays beside the morning's unsorted
 * pile. The pile is sorted down the tower by urgency; the top tray holds the
 * one letter that needs the executive, marked by a raised flag (the lit part).
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const TRAY = { x: -64, y: -40, w: 78, d: 62, r: 3 };
const TRAY_H = 5;
const LEVELS = [0, 18, 36];
const PILES = [6, 3, 1.4];

const top = LEVELS.at(-1) ?? 0;
const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[TRAY.x, TRAY.y, top + TRAY_H + 2],
	[TRAY.x + TRAY.w, TRAY.y + TRAY.d, top + TRAY_H + 26],
	[TRAY.x + TRAY.w + 20, TRAY.y + TRAY.d, top + TRAY_H + 24],
]);

function tray(z: number, pile: number, index: number) {
	s.solid(slabOf(TRAY, z, TRAY_H, s.P, 4, 0.6));
	s.line(planOutline(insetPlan(TRAY, 3), z + TRAY_H, s.P, 3), {
		tone: "faint",
	});
	const sheet = { x: TRAY.x + 8, y: TRAY.y + 8, w: 54, d: 42, r: 1 };
	s.solid(slabOf(sheet, z + TRAY_H, pile, s.P, 2), { crease: "none" });
	const face = z + TRAY_H + pile;
	s.line(
		lineOnTop(
			[sheet.x + 8, sheet.y + 10],
			[sheet.x + 40, sheet.y + 10],
			face,
			s.P
		),
		{ tone: index === 2 ? "mid" : "lo" }
	);
	s.line(
		lineOnTop(
			[sheet.x + 8, sheet.y + 18],
			[sheet.x + 30, sheet.y + 18],
			face,
			s.P
		),
		{ tone: "lo" }
	);
}

function posts(z0: number, z1: number) {
	for (const [x, y] of byDepth(corners(TRAY, 4), s)) {
		s.solid(cylinder(x, y, 1.8, z0, z1 - z0, s.P, 16));
	}
}

benchPlate(s, PLATE);
s.halo(TRAY, 0);
LEVELS.forEach((z, index) => {
	if (index > 0) {
		posts((LEVELS[index - 1] ?? 0) + TRAY_H, z);
	}
	tray(z, PILES[index] ?? 1, index);
});
// The executive's flag, clipped to the near corner of the top tray.
const flagX = TRAY.x + TRAY.w - 5;
const flagY = TRAY.y + TRAY.d - 5;
const flagZ = top + TRAY_H;
s.solid(cylinder(flagX, flagY, 1.4, flagZ, 24, s.P, 12), { tone: "lo" });
s.solid(
	slabOf(
		{ x: flagX + 1.4, y: flagY - 1, w: 18, d: 2, r: 0.4 },
		flagZ + 13,
		10,
		s.P,
		2
	),
	{ lit: true }
);
// The unsorted morning pile, waiting on the bench.
const pile = { x: 30, y: -24, w: 44, d: 34, r: 1 };
s.halo(pile, 0);
for (let i = 0; i < 6; i++) {
	s.solid(
		slabOf(
			{ ...pile, x: pile.x + (i % 2) * 2, y: pile.y - (i % 3) },
			i * 2.4,
			2.4,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
knob(s, [52, 30], 0, 5, 6);
screws(s, [[TRAY.x + TRAY.w - 6, TRAY.y + TRAY.d + 8]], 0, 1.4);

export const drawing = cardDrawing(s);
