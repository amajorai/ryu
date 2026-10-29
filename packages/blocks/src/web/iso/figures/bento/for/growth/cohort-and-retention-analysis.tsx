import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	sideArc,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Cohort and retention analysis: a coin-sorting tray. Each row is a cohort
 * and each stack a later week; the stacks shrink as users drop away. One row
 * holds its height, and its last stack (the lit one) marks the users that stuck.
 */

const PLATE = { x: -92, y: -60, w: 184, d: 120, r: 8 };
const TRAY = { x: -78, y: -48, w: 156, d: 96, r: 6 };
const TRAY_H = 5;
const COIN = 3;
const ROWS: [y: number, heights: number[]][] = [
	[-28, [8, 5, 4, 3, 3]],
	[0, [8, 7, 6, 6, 6]],
	[28, [8, 4, 2, 2, 1]],
];
const COLUMNS = [-56, -28, 0, 28, 56];
const RADIUS = 10;

const tallest = 8 * COIN + TRAY_H;
const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-56, -28, tallest]]);

type Stack = [x: number, y: number, coins: number, lit: boolean];

const stacks: Stack[] = ROWS.flatMap(([y, heights], row) =>
	heights.map(
		(coins, column): Stack => [
			COLUMNS[column] ?? 0,
			y,
			coins,
			row === 1 && column === heights.length - 1,
		]
	)
);

benchPlate(s, PLATE);
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(TRAY, 4), TRAY_H, s.P, 4), { tone: "faint" });
for (const [y] of ROWS) {
	s.line(
		lineOnTop(
			[TRAY.x + 8, y + RADIUS + 3],
			[TRAY.x + TRAY.w - 8, y + RADIUS + 3],
			TRAY_H,
			s.P
		),
		{
			tone: "lo",
		}
	);
}
screws(
	s,
	[
		[TRAY.x + 6, TRAY.y + 6],
		[TRAY.x + TRAY.w - 6, TRAY.y + TRAY.d - 6],
	],
	TRAY_H,
	1.4
);
for (const [x, y, coins, lit] of byDepth(stacks, s, TRAY_H)) {
	const height = coins * COIN;
	s.solid(cylinder(x, y, RADIUS, TRAY_H, height, s.P, 36, 0.5), {
		lit,
		tone: "mid",
	});
	for (let coin = 1; coin < coins; coin++) {
		s.line(sideArc(x, y, RADIUS, TRAY_H + coin * COIN, s.P), { tone: "faint" });
	}
}

export const drawing = cardDrawing(s);
