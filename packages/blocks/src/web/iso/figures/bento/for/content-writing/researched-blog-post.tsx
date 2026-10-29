import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Researched blog post: a copy stand and a source file. The long draft page
 * stands in its holder; beside it, a card box holds one card per source, and
 * a thread ties a claim on the page to the source card it came from (the lit
 * card, pulled up from the box).
 */

const PLATE = { x: -72, y: -46, w: 118, d: 92, r: 8 };
const STAND = { x: -62, y: -38, w: 86, d: 18, r: 3 };
const STAND_H = 8;
const PAGE = { x: -56, y: -31, w: 74, d: 3, r: 0.6 };
const PAGE_H = 62;
const BOX = { x: -22, y: -6, w: 50, d: 44, r: 3 };
const BOX_H = 18;
// y of each source card in the box, back to front; the lit one is pulled up.
const CARDS = [2, 10, 18, 26];
const PULLED = 1;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[PAGE.x, PAGE.y, STAND_H + PAGE_H],
]);

benchPlate(s, PLATE);
// Copy stand: a weighted base with a slot, the draft page standing in it.
s.halo(STAND, 0);
s.solid(slabOf(STAND, 0, STAND_H, s.P, 4, 0.8));
s.solid(slabOf(PAGE, STAND_H, PAGE_H, s.P, 2), { crease: "none" });
const face = PAGE.y + PAGE.d;
faceRules(
	s,
	"y",
	face,
	PAGE.x + 6,
	STAND_H + PAGE_H - 8,
	[50, 60, 44, 58, 52, 36, 56],
	6
);
faceRules(s, "y", face, PAGE.x + 6, STAND_H + 14, [56, 40], 6);
knob(s, [STAND.x + 6, STAND.y + 13], STAND_H, 3, 3);
// Source card box: an open-top box with index cards standing in it.
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 4, 0.8));
s.line(planOutline(insetPlan(BOX, 4), BOX_H, s.P, 3), { tone: "mid" });
CARDS.forEach((y, index) => {
	const pulled = index === PULLED;
	s.solid(
		slabOf(
			{ x: BOX.x + 7, y, w: BOX.w - 14, d: 1.6, r: 0.3 },
			BOX_H,
			pulled ? 22 : 7 + (index % 2) * 2,
			s.P,
			2
		),
		{ lit: pulled, crease: "none" }
	);
	if (pulled) {
		// The thread from the claim on the page down to its source card.
		s.wire(
			[PAGE.x + 62, face, STAND_H + PAGE_H - 20],
			[BOX.x + 14, y + 1.6, BOX_H + 18],
			[],
			{ tone: "mid" }
		);
	}
});
screws(
	s,
	[
		[BOX.x + 6, BOX.y + BOX.d - 4],
		[BOX.x + BOX.w - 6, BOX.y + BOX.d - 4],
	],
	BOX_H,
	1.2
);

export const drawing = cardDrawing(s);
