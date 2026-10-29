import {
	boxCorners,
	cylinder,
	knurl,
	lineOnTop,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Proposal and SOW drafting: a screw press. Past engagements stand as bound
 * volumes beside it; the press works their pattern onto a fresh sheet, which
 * slides out the front for your review (the lit sheet).
 */

const PLATE = { x: -100, y: -48, w: 168, d: 90, r: 8 };
const BED = { x: -38, y: -26, w: 80, d: 48, r: 4 };
const BED_H = 8;
const COL_H = 44;
const COLS = [-28, 32];
const SCREW: [number, number] = [2, -2];
const BAR_Z = BED_H + COL_H;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners({ x: -88, y: -36, w: 36, d: 30, r: 1 }, 0, 32),
	...boxCorners({ x: -34, y: SCREW[1] - 7, w: 72, d: 14, r: 3 }, BAR_Z, 7),
	[SCREW[0], SCREW[1], BAR_Z + 14],
]);

benchPlate(s, PLATE);
// Bound volumes of past engagements, spines to the front.
for (let i = 0; i < 4; i++) {
	const x = -88 + i * 9;
	const height = [30, 26, 32, 24][i] ?? 28;
	s.solid(slabOf({ x, y: -36, w: 8, d: 30, r: 1 }, 0, height, s.P, 2, 0.4), {
		tone: i % 2 ? "lo" : "mid",
	});
	faceRules(s, "y", -6, x + 2, height - 5, [4, 4], 6);
}
// The press bed and the sheet on it, sliding out of the front.
s.halo(BED, 0);
s.solid(slabOf(BED, 0, BED_H, s.P, 6, 0.8));
const sheet = { x: -14, y: -18, w: 32, d: 52, r: 1 };
s.solid(slabOf(sheet, BED_H, 1, s.P, 2), { lit: true, crease: "none" });
for (let i = 0; i < 3; i++) {
	const y = 22 + i * 4;
	s.line(
		lineOnTop([sheet.x + 4, y], [sheet.x + 26 - i * 5, y], BED_H + 1, s.P),
		{
			tone: "mid",
		}
	);
}
const column = (x: number) =>
	s.solid(cylinder(x, SCREW[1], 4, BED_H, COL_H, s.P, 24));
column(COLS[0] ?? -28);
// Platen and screw hanging from the crossbar.
s.solid(
	slabOf({ x: -12, y: -14, w: 28, d: 24, r: 2 }, BED_H + 12, 5, s.P, 3, 0.6),
	{
		tone: "lo",
	}
);
s.solid(cylinder(SCREW[0], SCREW[1], 3, BED_H + 17, COL_H - 17, s.P, 20));
s.line(knurl(SCREW[0], SCREW[1], 3, BED_H + 20, BAR_Z - 4, 16, s.P), {
	tone: "lo",
});
column(COLS[1] ?? 32);
s.solid(
	slabOf({ x: -34, y: SCREW[1] - 7, w: 72, d: 14, r: 3 }, BAR_Z, 7, s.P, 4, 0.8)
);
screws(
	s,
	[
		[COLS[0] ?? -28, SCREW[1]],
		[COLS[1] ?? 32, SCREW[1]],
	],
	BAR_Z + 7,
	1.6
);
// Hand wheel on top of the screw.
s.solid(cylinder(SCREW[0], SCREW[1], 3, BAR_Z + 7, 3, s.P, 20), { tone: "lo" });
s.solid(cylinder(SCREW[0], SCREW[1], 13, BAR_Z + 10, 3, s.P, 40, 0.5));
s.line(ring(SCREW[0], SCREW[1], 9, BAR_Z + 13, s.P, 40), { tone: "lo" });
s.solid(cylinder(SCREW[0], SCREW[1], 3, BAR_Z + 13, 2, s.P, 20), {
	tone: "lo",
});

export const drawing = cardDrawing(s);
