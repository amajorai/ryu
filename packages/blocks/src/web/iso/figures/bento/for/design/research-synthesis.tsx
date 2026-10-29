import { boxCorners, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Research synthesis: a card file. Session notes are filed into clusters
 * behind tabbed dividers, each divider a finding; one finding's tab (the lit
 * part) stands raised. Unsorted notes wait in a clipped stack beside it.
 */

const PLATE = { x: -96, y: -48, w: 186, d: 96, r: 8 };
const TRAY = { x: -84, y: -24, w: 112, d: 48, r: 3 };
const WALL = 3;
const FLOOR = 3;
const CARD_H = 24;
const CARD_Y = TRAY.y + WALL + 2;
const CARD_D = TRAY.d - WALL * 2 - 4;
const CLUSTERS = [6, 5, 7];
const LIT_DIVIDER = 1;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners(TRAY, 0, FLOOR + CARD_H + 13),
]);

function card(x: number) {
	s.solid(
		slabOf({ x, y: CARD_Y, w: 1.2, d: CARD_D, r: 0 }, FLOOR, CARD_H, s.P, 1),
		{ crease: "none" }
	);
}

function divider(x: number, index: number) {
	const tabY = CARD_Y + 2 + index * 13;
	s.solid(
		slabOf(
			{ x, y: CARD_Y, w: 1.6, d: CARD_D, r: 0 },
			FLOOR,
			CARD_H + 3,
			s.P,
			1
		),
		{ tone: "lo", crease: "none" }
	);
	s.solid(
		slabOf({ x, y: tabY, w: 2, d: 12, r: 0.6 }, FLOOR + CARD_H + 3, 9, s.P, 2),
		{ lit: index === LIT_DIVIDER, tone: "lo", crease: "none" }
	);
}

benchPlate(s, PLATE);
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, FLOOR, s.P, 4, 0.6), { tone: "lo" });
// Back and left walls first, then the files, then the low front and right.
s.solid(slabOf({ ...TRAY, d: WALL, r: 1 }, FLOOR, 18, s.P, 2));
s.solid(slabOf({ ...TRAY, w: WALL, r: 1 }, FLOOR, 18, s.P, 2));
let x = TRAY.x + WALL + 5;
CLUSTERS.forEach((count, index) => {
	divider(x, index);
	x += 5;
	for (let i = 0; i < count; i++) {
		card(x);
		x += 4;
	}
	x += 4;
});
s.solid(
	slabOf(
		{ ...TRAY, x: TRAY.x + TRAY.w - WALL, w: WALL, r: 1 },
		FLOOR,
		18,
		s.P,
		2
	)
);
s.solid(
	slabOf(
		{ ...TRAY, y: TRAY.y + TRAY.d - WALL, d: WALL, r: 1 },
		FLOOR,
		10,
		s.P,
		2
	)
);
screws(s, [[TRAY.x + 10, TRAY.y + TRAY.d - 1.5]], FLOOR + 10, 1);
// Unsorted session notes, clipped together on the bench.
const notes = [
	{ x: 46, y: -20, w: 30, d: 36, r: 2 },
	{ x: 48, y: -18, w: 30, d: 36, r: 2 },
	{ x: 45, y: -15, w: 30, d: 36, r: 2 },
];
s.halo(notes[1] ?? TRAY, 0);
notes.forEach((plan, index) => {
	s.solid(slabOf(plan, index * 2, 2, s.P, 3), {
		tone: index === 2 ? "mid" : "lo",
		crease: "none",
	});
});
s.solid(slabOf({ x: 52, y: -17, w: 14, d: 6, r: 1 }, 6, 3, s.P, 2), {
	tone: "lo",
});

export const drawing = cardDrawing(s);
