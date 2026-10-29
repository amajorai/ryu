import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Account research: a card-index box (your CRM, one card per account) beside
 * a clipboard holding the single page brief it was pulled into. The clip that
 * holds that one page is the lit part.
 */

const PLATE = { x: -50, y: -98, w: 100, d: 192, r: 8 };
const BOX = { x: -32, y: -86, w: 64, d: 62, r: 4 };
const BOX_H = 26;
const BOARD = { x: -42, y: -12, w: 84, d: 96, r: 4 };
const PAGE = insetPlan(BOARD, 6);
const CARD_TOP = BOX_H + 12;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[BOX.x, BOX.y, CARD_TOP + 8],
]);

benchPlate(s, PLATE);
// Index box, open on top, with cards standing in it back to front.
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 6, 0.8));
s.solid(slabOf(insetPlan(BOX, 4), BOX_H - 0.6, 0.6, s.P, 4), {
	tone: "lo",
	crease: "none",
});
faceRules(s, "y", BOX.y + BOX.d, BOX.x + 10, 18, [22], 4);
s.solid(
	slabOf({ x: BOX.x + 24, y: BOX.y + BOX.d, w: 14, d: 3, r: 1 }, 8, 4, s.P, 2),
	{ tone: "lo" }
);
for (let i = 0; i < 6; i++) {
	const y = BOX.y + 9 + i * 9;
	const card = { x: BOX.x + 8, y, w: BOX.w - 16, d: 1.6, r: 0.4 };
	s.solid(slabOf(card, BOX_H, CARD_TOP - BOX_H - (i % 2) * 3, s.P, 2), {
		crease: "none",
	});
	if (i % 2 === 0) {
		const tab = { x: card.x + 6 + i * 4, y, w: 10, d: 1.6, r: 0.4 };
		s.solid(slabOf(tab, CARD_TOP, 4, s.P, 2), { tone: "lo", crease: "none" });
	}
}
// The clipboard and its one page brief.
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, 3, s.P, 6, 0.6), { tone: "lo" });
s.solid(slabOf(PAGE, 3, 1, s.P, 3), { crease: "none" });
const top = 4;
s.line(
	lineOnTop([PAGE.x + 8, PAGE.y + 16], [PAGE.x + 44, PAGE.y + 16], top, s.P),
	{ tone: "mid" }
);
[60, 52, 58, 40, 56, 48, 60, 44, 30].forEach((length, i) => {
	const y = PAGE.y + 25 + i * 6.6;
	s.line(lineOnTop([PAGE.x + 8, y], [PAGE.x + 8 + length, y], top, s.P), {
		tone: "lo",
	});
});
s.line(
	planOutline(
		{ x: PAGE.x + 50, y: PAGE.y + 8, w: 16, d: 12, r: 1 },
		top,
		s.P,
		2
	),
	{
		tone: "lo",
	}
);
const clip = { x: BOARD.x + 26, y: BOARD.y + 1, w: 32, d: 10, r: 2 };
s.solid(slabOf(clip, 3, 4, s.P, 3, 0.4), { lit: true });
screws(
	s,
	[
		[clip.x + 6, clip.y + 5],
		[clip.x + clip.w - 6, clip.y + 5],
	],
	7,
	1.2
);

export const drawing = cardDrawing(s);
