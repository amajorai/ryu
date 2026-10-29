import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, faceRules, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Action links: a notice card standing in its holder, with a strip of three
 * push buttons in front, one per link. The one that opens the run a person
 * needs is lit.
 */

const PLATE = { x: -82, y: -46, w: 164, d: 78, r: 8 };
const HOLDER = { x: -58, y: -34, w: 116, d: 14, r: 3 };
const HOLDER_H = 8;
const CARD = { x: -50, y: -29, w: 100, d: 3, r: 1 };
const CARD_H = 54;
const STRIP = { x: -58, y: HOLDER.y + HOLDER.d, w: 116, d: 32, r: 4 };
const STRIP_H = 8;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CARD.x, CARD.y, HOLDER_H + CARD_H + 2],
]);

benchPlate(s, PLATE);
s.halo(HOLDER, 0);
s.solid(slabOf(HOLDER, 0, HOLDER_H, s.P, 4, 0.6));
s.solid(slabOf(CARD, HOLDER_H - 4, CARD_H + 4, s.P, 3));
const face = CARD.y + CARD.d;
const top = HOLDER_H + CARD_H;
s.line(faceRect(s, "y", face, CARD.x + 8, CARD.x + 24, top - 18, top - 6), {
	tone: "lo",
});
faceRules(s, "y", face, CARD.x + 30, top - 8, [56, 44, 50], 5);
faceRules(s, "y", face, CARD.x + 8, top - 28, [80, 72, 60, 76], 5);
// A clip holds the card at the top.
s.solid(
	slabOf(
		{ x: -6, y: CARD.y - 2, w: 12, d: 7, r: 1.5 },
		top - 6,
		8,
		s.P,
		3,
		0.4
	),
	{ tone: "lo" }
);
// Button strip: three links.
s.halo(STRIP, 0);
s.solid(slabOf(STRIP, 0, STRIP_H, s.P, 5, 0.6));
s.line(planOutline(insetPlan(STRIP, 4), STRIP_H, s.P, 4), { tone: "faint" });
for (const [index, x] of [-34, 0, 34].entries()) {
	const y = STRIP.y + STRIP.d / 2;
	s.solid(cylinder(x, y, 11, STRIP_H, 2, s.P, 36, 0.4), { tone: "lo" });
	s.solid(cylinder(x, y, 8.5, STRIP_H + 2, 5, s.P, 36, 0.8), {
		lit: index === 1,
	});
	s.line(ring(x, y, 5, STRIP_H + 7, s.P, 24), { tone: "faint" });
}
screws(
	s,
	[
		[STRIP.x + 6, STRIP.y + 6],
		[STRIP.x + STRIP.w - 6, STRIP.y + STRIP.d - 6],
	],
	STRIP_H,
	1.2
);

export const drawing = cardDrawing(s);
