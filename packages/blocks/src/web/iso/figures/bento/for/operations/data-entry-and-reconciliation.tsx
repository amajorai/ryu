import { boxCorners, planOutline, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Data entry and reconciliation: a two-rail matching gauge. The source
 * system's records stand on the back rail, their copies on the front rail,
 * and a link bar joins each pair that matches. One copy stands taller than
 * its source and has no link: the mismatch (lit) waiting for a person.
 */

const PLATE = { x: -104, y: -56, w: 208, d: 112, r: 8 };
const RAIL_H = 5;
const XS = [-72, -40, -8, 24, 56];
const SOURCE = [12, 18, 10, 14, 16];
const COPY = [12, 18, 10, 24, 16];
const MISMATCH = 3;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [24, 20, 34]]);

function railRow(y: number, heights: number[], copies: boolean) {
	const base = { x: -88, y: y - 10, w: 160, d: 20, r: 3 };
	s.halo(base, 0);
	s.solid(slabOf(base, 0, RAIL_H, s.P, 4, 0.6), { tone: "lo" });
	screws(
		s,
		[
			[base.x + 6, y],
			[base.x + base.w - 6, y],
		],
		RAIL_H,
		1.3
	);
	XS.forEach((x, i) => {
		const lit = copies && i === MISMATCH;
		s.solid(
			slabOf(
				{ x: x - 8, y: y - 7, w: 16, d: 14, r: 2 },
				RAIL_H,
				heights[i] ?? 10,
				s.P,
				4,
				0.5
			),
			{ lit }
		);
		s.line(
			planOutline(
				{ x: x - 5, y: y - 4, w: 10, d: 8, r: 1 },
				RAIL_H + (heights[i] ?? 10),
				s.P,
				2
			),
			{ tone: "faint" }
		);
	});
}

benchPlate(s, PLATE);
railRow(-30, SOURCE, false);
// Link bars across the gap for each matched pair.
XS.forEach((x, i) => {
	if (i !== MISMATCH) {
		s.solid(slabOf({ x: x - 2, y: -20, w: 4, d: 40, r: 1 }, 0, 3, s.P, 2));
	}
});
railRow(30, COPY, true);
// Status lamp at the end of the front rail.
s.solid(slabOf({ x: 78, y: 18, w: 16, d: 24, r: 3 }, 0, 8, s.P, 3, 0.5));
lamp(s, [86, 30], 8, { radius: 2.4 });

export const drawing = cardDrawing(s);
