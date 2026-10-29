import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Churn risk flagging: the book of accounts as a card file. Every renewal is
 * a card standing in the box; the one showing warning signs has been pulled
 * up with a flag tab clipped to it (the lit part), so it is seen early.
 */

const PLATE = { x: -84, y: -56, w: 168, d: 112, r: 8 };
const BOX = { x: -46, y: -40, w: 92, d: 72, r: 3 };
const BOX_H = 22;
const CARD_X = BOX.x + 6;
const CARD_W = BOX.w - 12;
const FLAGGED = 5;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, BOX_H + 34]]);

function card(index: number) {
	const y = BOX.y + 10 + index * 6;
	const raised = index === FLAGGED;
	const height = raised ? 22 : 10;
	s.solid(
		slabOf({ x: CARD_X, y, w: CARD_W, d: 1.4, r: 0 }, BOX_H, height, s.P, 1),
		{ crease: "none" }
	);
	// Index tabs step along the cards so each one can be found.
	const tabX = CARD_X + 6 + (index % 4) * 16;
	if (!raised) {
		s.solid(
			slabOf({ x: tabX, y, w: 12, d: 1.4, r: 0 }, BOX_H + height, 3, s.P, 1),
			{ crease: "none" }
		);
		return;
	}
	s.solid(
		slabOf(
			{ x: CARD_X + CARD_W - 18, y: y - 0.4, w: 14, d: 2.2, r: 0 },
			BOX_H + height - 6,
			14,
			s.P,
			1
		),
		{ lit: true, crease: "none" }
	);
}

benchPlate(s, PLATE);
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 4, 0.8));
s.line(planOutline(insetPlan(BOX, 3), BOX_H, s.P, 2), { tone: "lo" });
// The follower block that keeps the cards upright, at the back.
s.solid(
	slabOf(
		{ x: CARD_X, y: BOX.y + 4, w: CARD_W, d: 3, r: 0.5 },
		BOX_H,
		6,
		s.P,
		2
	),
	{ tone: "lo" }
);
for (let i = 0; i < 9; i++) {
	card(i);
}
const front = BOX.y + BOX.d;
s.line(faceRect(s, "y", front, -14, 14, 13, 19), { tone: "mid" });
s.solid(slabOf({ x: -8, y: front, w: 16, d: 3, r: 1 }, 7, 3, s.P, 2), {
	tone: "lo",
});
screws(
	s,
	[
		[BOX.x + BOX.w + 14, BOX.y + 8],
		[BOX.x + BOX.w + 14, front - 8],
	],
	0,
	1.6
);

export const drawing = cardDrawing(s);
