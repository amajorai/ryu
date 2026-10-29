import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Deliverable drafting: a slotted rack that sets slides in storyline order.
 * The cards stand in the template's slots one after another; the lead card
 * at the front, the one being drafted now, is the lit part, held square by
 * the end stop and its clamp knob.
 */

const PLATE = { x: -96, y: -36, w: 172, d: 72, r: 8 };
const RAIL = { x: -82, y: -20, w: 150, d: 40, r: 4 };
const RAIL_H = 8;
const CARD_H = 38;
const SLOTS = [-66, -42, -18, 6, 30];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-66, -16, RAIL_H + CARD_H],
	[30, -16, RAIL_H + CARD_H],
]);

benchPlate(s, PLATE);
s.halo(RAIL, 0);
s.solid(slabOf(RAIL, 0, RAIL_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(RAIL, 4), RAIL_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[RAIL.x + 8, RAIL.y + 8],
		[RAIL.x + RAIL.w - 8, RAIL.y + RAIL.d - 8],
	],
	RAIL_H,
	1.4
);
SLOTS.forEach((x, index) => {
	const lit = index === SLOTS.length - 1;
	const card = { x, y: RAIL.y + 4, w: 3, d: RAIL.d - 8, r: 0.5 };
	s.solid(
		slabOf(
			{ x: x - 2, y: card.y - 1, w: 7, d: card.d + 2, r: 1 },
			RAIL_H,
			2,
			s.P,
			2
		),
		{
			tone: "lo",
		}
	);
	s.solid(slabOf(card, RAIL_H + 2, CARD_H - 2, s.P, 2), lit ? { lit } : {});
	faceRules(
		s,
		"x",
		x + 3,
		card.y + 5,
		RAIL_H + CARD_H - 6,
		lit ? [22, 16, 18, 10] : [18, 12, 14],
		5
	);
});
// End stop with a clamp knob, squaring the lead card.
const stop = { x: 46, y: -12, w: 12, d: 24, r: 2 };
s.solid(slabOf(stop, RAIL_H, 16, s.P, 4, 0.6));
knob(s, [52, 0], RAIL_H + 16, 4, 5);

export const drawing = cardDrawing(s);
