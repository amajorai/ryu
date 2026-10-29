import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Exception reporting: a card index, one card per ledger entry. A duplicate,
 * a miscategorized line and an unusual amount each get a flag clipped to
 * their own card, so every exception stays tied to its entry; the newest
 * one is pulled up for review (the lit card). The report it feeds lies in
 * the tray beside the drawer.
 */

const PLATE = { x: -82, y: -56, w: 156, d: 110, r: 8 };
const BOX = { x: -70, y: -46, w: 60, d: 90, r: 4 };
const BOX_H = 20;
const CARD_H = 12;
const CARDS = 12;
const FLAGS = new Map<number, number>([
	[2, 8],
	[5, 30],
	[9, 18],
]);
const PULLED = 9;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-40, 0, BOX_H + 34],
]);

benchPlate(s, PLATE);
// The drawer: walls, a pull on its front face, an open top.
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BOX, 4), BOX_H, s.P, 3), { tone: "lo" });
const front = BOX.y + BOX.d;
s.line(faceRect(s, "y", front, BOX.x + 20, BOX.x + 40, 8, 14), { tone: "lo" });
// Cards standing in the drawer, back to front.
for (let i = 0; i < CARDS; i++) {
	const y = BOX.y + 7 + i * 6.6;
	const pulled = i === PULLED;
	const top = BOX_H + CARD_H + (pulled ? 14 : 0) - (i % 3 === 1 ? 2 : 0);
	s.solid(
		slabOf(
			{ x: BOX.x + 6, y, w: BOX.w - 12, d: 1.6, r: 0.3 },
			BOX_H,
			top - BOX_H,
			s.P,
			2
		),
		{ lit: pulled, crease: "none" }
	);
	const flagX = FLAGS.get(i);
	if (flagX !== undefined) {
		s.solid(
			slabOf(
				{ x: BOX.x + 6 + flagX, y: y - 0.4, w: 10, d: 2.4, r: 0.4 },
				top,
				5,
				s.P,
				2
			),
			{ tone: "lo" }
		);
	}
}
// Report tray beside the drawer, sheets stacked in it.
const TRAY = { x: 4, y: -18, w: 56, d: 46, r: 4 };
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 6, s.P, 4, 0.6));
s.line(planOutline(insetPlan(TRAY, 4), 6, s.P, 3), { tone: "lo" });
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf({ x: 12 + i, y: -10 - i, w: 38, d: 30, r: 1 }, 6 + i * 2, 2, s.P, 2),
		{ tone: i === 2 ? "mid" : "lo", crease: "none" }
	);
}
s.solid(cylinder(42, 0, 4, 12, 3, s.P, 20), { tone: "lo" });

export const drawing = cardDrawing(s);
