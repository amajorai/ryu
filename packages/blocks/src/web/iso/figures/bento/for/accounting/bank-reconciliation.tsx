import {
	boxCorners,
	cylinder,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Bank reconciliation: a matching jig. Statement blocks stand in the back
 * row, ledger blocks in the front row, and a link bar joins each matched
 * pair. One statement block has no partner: its empty socket is marked in
 * front and a flag (lit) stands on it, waiting for an adjusting entry. The
 * slip tray beside the jig holds the drafted entries.
 */

const PLATE = { x: -106, y: -54, w: 212, d: 108, r: 8 };
const BASE = { x: -94, y: -42, w: 150, d: 84, r: 4 };
const BASE_H = 6;
const COLUMNS = [-74, -42, -10, 22];
const UNMATCHED = -10;
const BLOCK = { w: 22, d: 14 };
const BACK_Y = BASE.y + 6;
const FRONT_Y = BASE.y + BASE.d - 6 - BLOCK.d;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[UNMATCHED, BACK_Y, BASE_H + 40],
]);

function block(x: number, y: number) {
	const plan = { x: x - BLOCK.w / 2, y, w: BLOCK.w, d: BLOCK.d, r: 2 };
	s.halo(plan, BASE_H);
	s.solid(slabOf(plan, BASE_H, 12, s.P, 4, 0.6));
}

benchPlate(s, PLATE);
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 0.8));
screws(
	s,
	[
		[BASE.x + 6, BASE.y + BASE.d / 2],
		[BASE.x + BASE.w - 6, BASE.y + BASE.d / 2],
	],
	BASE_H,
	1.4
);
for (const x of COLUMNS) {
	block(x, BACK_Y);
}
// The flag on the unmatched statement block.
const flagZ = BASE_H + 12;
s.solid(cylinder(UNMATCHED, BACK_Y + 7, 1, flagZ, 26, s.P, 16), {
	tone: "lo",
});
s.solid(
	slabOf(
		{ x: UNMATCHED, y: BACK_Y + 6, w: 14, d: 2, r: 0.4 },
		flagZ + 16,
		10,
		s.P,
		2
	),
	{ lit: true }
);
// Link bars lying on the jig between matched pairs.
for (const x of COLUMNS) {
	if (x === UNMATCHED) {
		s.line(
			planOutline(
				{ x: x - BLOCK.w / 2, y: FRONT_Y, w: BLOCK.w, d: BLOCK.d, r: 2 },
				BASE_H,
				s.P,
				4
			),
			{ tone: "mid" }
		);
		continue;
	}
	const bar = {
		x: x - 3,
		y: BACK_Y + BLOCK.d,
		w: 6,
		d: FRONT_Y - BACK_Y - BLOCK.d,
		r: 1,
	};
	s.solid(slabOf(bar, BASE_H, 2, s.P, 2), { tone: "lo" });
}
for (const x of COLUMNS) {
	if (x !== UNMATCHED) {
		block(x, FRONT_Y);
	}
}
// Drafted adjusting entries in a slip tray.
const tray = { x: 66, y: -30, w: 30, d: 60, r: 3 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 5, s.P, 4, 0.6), { tone: "lo" });
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf(
			{ x: tray.x + 5, y: tray.y + 6 + i * 3, w: 20, d: 26, r: 1 },
			5 + i * 1.2,
			1.2,
			s.P,
			2
		),
		{ crease: "none" }
	);
}

export const drawing = cardDrawing(s);
