import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Financial statement drafting: a collator. The trial balance waits as a
 * paper stack in the feed tray at the back; a carriage on the rail deals it
 * into three bins, one per statement (P&L, balance sheet, cash flow). The
 * draft in the middle bin (lit) is ready for the reviewer's stamp beside it.
 */

const PLATE = { x: -104, y: -56, w: 208, d: 112, r: 8 };
const FEED = { x: -86, y: -44, w: 46, d: 34, r: 3 };
const RAIL = { x: -88, y: -4, w: 140, d: 6, r: 1 };
const BINS = [-82, -36, 10];
const BIN = { w: 38, d: 36 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [70, -30, 30]]);

function sheet(x: number, y: number, z: number, lit = false) {
	s.solid(slabOf({ x, y, w: 28, d: 24, r: 1 }, z, 1, s.P, 2), {
		lit,
		crease: "none",
	});
}

benchPlate(s, PLATE);
// Feed tray with the trial balance stacked in it.
s.halo(FEED, 0);
s.solid(slabOf(FEED, 0, 4, s.P, 4, 0.6), { tone: "lo" });
for (let i = 0; i < 6; i++) {
	sheet(FEED.x + 9 + (i % 2) * 0.8, FEED.y + 5, 4 + i * 1.6);
}
// Reviewer's stamp, standing at the back right.
const stamp: [number, number] = [70, -30];
s.halo({ x: 56, y: -42, w: 28, d: 24, r: 3 }, 0);
s.solid(slabOf({ x: 56, y: -42, w: 28, d: 24, r: 3 }, 0, 4, s.P, 4, 0.4), {
	tone: "lo",
});
s.solid(slabOf({ x: 60, y: -38, w: 20, d: 16, r: 2 }, 4, 8, s.P, 3, 0.4));
s.solid(cylinder(stamp[0], stamp[1], 2.5, 12, 8, s.P, 20), { tone: "lo" });
s.solid(cylinder(stamp[0], stamp[1], 6, 20, 9, s.P, 28));
s.line(knurl(stamp[0], stamp[1], 6, 20, 29, 24, s.P), { tone: "faint" });
// The carriage rail across the front of the feed.
s.solid(slabOf(RAIL, 0, 5, s.P, 2, 0.4));
screws(
	s,
	[
		[RAIL.x + 4, RAIL.y + 3],
		[RAIL.x + RAIL.w - 4, RAIL.y + 3],
	],
	5,
	1.2
);
s.solid(
	slabOf({ x: -24, y: RAIL.y - 3, w: 18, d: 12, r: 2 }, 5, 7, s.P, 3, 0.4),
	{
		tone: "lo",
	}
);
// Three output bins, one statement each.
BINS.forEach((x, index) => {
	const bin = { x, y: 10, w: BIN.w, d: BIN.d, r: 3 };
	s.halo(bin, 0);
	s.solid(slabOf(bin, 0, 6, s.P, 4, 0.6));
	const floor = insetPlan(bin, 3);
	s.solid(slabOf(floor, 6, 0.1, s.P, 3), { tone: "lo", crease: "none" });
	sheet(bin.x + 5, bin.y + 6, 6.1, index === 1);
	if (index !== 1) {
		for (let i = 0; i < 3; i++) {
			const y = bin.y + 11 + i * 4;
			s.line(lineOnTop([bin.x + 9, y], [bin.x + 26 - i * 4, y], 7.1, s.P), {
				tone: "lo",
			});
		}
	}
});

export const drawing = cardDrawing(s);
