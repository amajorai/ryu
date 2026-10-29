import {
	boxCorners,
	cylinder,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Performance recaps: a column gauge. Last week's numbers stand as columns
 * in a tray against the goal rail behind them; the one column that cleared
 * its goal is lit. The printer beside it feeds out the written recap slip.
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const TRAY = { x: -86, y: -18, w: 104, d: 34, r: 4 };
const TRAY_H = 6;
const GOAL_Z = 36;
const RAIL_Y = -28;
const COLUMNS = [20, 28, 24, 52, 26];
const PRINTER = { x: 34, y: -32, w: 48, d: 42, r: 4 };
const PRINTER_H = 18;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-21, -10, TRAY_H + 56],
	[-86, RAIL_Y, GOAL_Z + 4],
]);

benchPlate(s, PLATE);
// Goal rail on two posts, behind the tray.
for (const x of [-82, 12]) {
	s.solid(cylinder(x, RAIL_Y, 4, 0, 2, s.P, 20), { tone: "lo" });
	s.solid(cylinder(x, RAIL_Y, 2.4, 2, GOAL_Z - 2, s.P, 20));
}
s.solid(
	slabOf({ x: -86, y: RAIL_Y - 2, w: 102, d: 4, r: 1 }, GOAL_Z, 3, s.P, 2),
	{ tone: "lo" }
);
// The tray of columns.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 6, 0.8));
COLUMNS.forEach((height, i) => {
	const x = TRAY.x + 8 + i * 19;
	s.solid(
		slabOf(
			{ x, y: TRAY.y + 8, w: 13, d: 16, r: 1.5 },
			TRAY_H,
			height,
			s.P,
			3,
			0.5
		),
		{ lit: height + TRAY_H > GOAL_Z }
	);
});
screws(
	s,
	[
		[TRAY.x + 5, TRAY.y + TRAY.d - 5],
		[TRAY.x + TRAY.w - 5, TRAY.y + TRAY.d - 5],
	],
	TRAY_H,
	1.2
);
// Recap printer with its slip fed out of the front.
s.halo(PRINTER, 0);
s.solid(slabOf(PRINTER, 0, PRINTER_H, s.P, 6, 1));
lamp(s, [PRINTER.x + 9, PRINTER.y + 9], PRINTER_H, { radius: 1.8 });
s.line(
	lineOnTop(
		[PRINTER.x + 8, PRINTER.y + PRINTER.d - 8],
		[PRINTER.x + PRINTER.w - 8, PRINTER.y + PRINTER.d - 8],
		PRINTER_H,
		s.P
	),
	{ tone: "mid" }
);
faceRules(s, "x", PRINTER.x + PRINTER.w, PRINTER.y + 8, 12, [20, 14], 4);
const slip = {
	x: PRINTER.x + 10,
	y: PRINTER.y + PRINTER.d - 2,
	w: 28,
	d: 30,
	r: 1,
};
s.solid(slabOf(slip, 0, 1.2, s.P, 2), { crease: "none" });
for (const [i, length] of [20, 14, 18].entries()) {
	const y = slip.y + 10 + i * 6;
	s.line(lineOnTop([slip.x + 4, y], [slip.x + 4 + length, y], 1.2, s.P), {
		tone: "lo",
	});
}

export const drawing = cardDrawing(s);
