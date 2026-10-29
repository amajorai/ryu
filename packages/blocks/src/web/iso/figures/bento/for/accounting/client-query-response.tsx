import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Client query response: the reply on a clipboard, its figure picked out
 * (the lit bar), beside a receipt spike holding the invoices and ledger slips
 * that figure is cited to.
 */

const PLATE = { x: -98, y: -52, w: 196, d: 104, r: 8 };
const BOARD = { x: -82, y: -40, w: 84, d: 80, r: 3 };
const SHEET = { x: -76, y: -26, w: 72, d: 60, r: 1 };
const SHEET_Z = 3.8;
const SPIKE: [number, number] = [50, -4];
const SPIKE_TOP = 34;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[SPIKE[0], SPIKE[1], SPIKE_TOP],
]);

benchPlate(s, PLATE);
// Clipboard, sheet and clip.
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, 3, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(SHEET, 3, 0.8, s.P, 2), { crease: "none" });
const lines = [56, 44, 60, 30, 52, 40];
lines.forEach((length, i) => {
	const y = SHEET.y + 18 + i * 7;
	if (i === 3) {
		s.solid(
			slabOf(
				{ x: SHEET.x + 34, y: y - 2.4, w: 26, d: 4.8, r: 1 },
				SHEET_Z,
				1.4,
				s.P,
				2
			),
			{
				lit: true,
				crease: "none",
			}
		);
	}
	s.line(
		lineOnTop(
			[SHEET.x + 6, y],
			[SHEET.x + 6 + length * (i === 3 ? 0.9 : 1), y],
			SHEET_Z,
			s.P
		),
		{
			tone: i === 0 ? "mid" : "lo",
		}
	);
});
const clip = { x: -60, y: -38, w: 40, d: 16, r: 2 };
s.solid(slabOf(clip, 3, 5, s.P, 3, 0.6));
s.solid(slabOf(insetPlan(clip, 4), 8, 2, s.P, 2, 0.4), { tone: "lo" });
screws(
	s,
	[
		[clip.x + 4, clip.y + 4],
		[clip.x + clip.w - 4, clip.y + 4],
	],
	8,
	1
);
// Receipt spike with its slips.
s.halo({ x: SPIKE[0] - 16, y: SPIKE[1] - 16, w: 32, d: 32, r: 16 }, 0);
s.solid(cylinder(SPIKE[0], SPIKE[1], 16, 0, 4, s.P, 40, 0.6), { tone: "lo" });
s.solid(cylinder(SPIKE[0], SPIKE[1], 4, 4, 2, s.P, 24));
// The slips have slid down the spike and rest in a pile on its boss.
const SLIP_T = 1.4;
for (let i = 0; i < 4; i++) {
	const top = 6 + i * SLIP_T;
	const slip = {
		x: SPIKE[0] - 15 + (i % 2) * 3,
		y: SPIKE[1] - 12 - (i % 2) * 2,
		w: 30,
		d: 24,
		r: 1,
	};
	s.solid(slabOf(slip, top, SLIP_T, s.P, 2), { crease: "none" });
	s.line(
		lineOnTop(
			[slip.x + 5, slip.y + 18],
			[slip.x + 20, slip.y + 18],
			top + SLIP_T,
			s.P
		),
		{
			tone: "lo",
		}
	);
}
const pileTop = 6 + 4 * SLIP_T;
s.solid(
	cylinder(SPIKE[0], SPIKE[1], 1, pileTop, SPIKE_TOP - pileTop, s.P, 12),
	{
		tone: "lo",
	}
);

export const drawing = cardDrawing(s);
