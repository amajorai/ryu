import {
	boxCorners,
	corners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Answer in place: a call-button panel. An agent's request has lit the call
 * lamp on the raised back, and the two big mushroom buttons on the deck answer
 * it right there: approve is pressed home and lit, reject stands up dark.
 */

const PLATE = { x: -86, y: -52, w: 172, d: 104, r: 8 };
const DECK = { x: -60, y: -26, w: 120, d: 56, r: 6 };
const DECK_H = 10;
const BACK = { x: -60, y: -44, w: 120, d: 18, r: 4 };
const BACK_H = 24;
const BUTTONS: [number, boolean][] = [
	[-24, true],
	[24, false],
];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, BACK_H + 8]]);

benchPlate(s, PLATE);
s.halo({ ...BACK, d: BACK.d + DECK.d }, 0);
// Raised back: the call lamp and a row of quiet status lamps.
s.solid(slabOf(BACK, 0, BACK_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BACK, 3), BACK_H, s.P, 3), { tone: "faint" });
lamp(s, [-30, BACK.y + 9], BACK_H, { radius: 1.6 });
lamp(s, [-18, BACK.y + 9], BACK_H, { radius: 1.6 });
s.solid(cylinder(10, BACK.y + 9, 5.5, BACK_H, 1, s.P, 28), { tone: "lo" });
s.solid(cylinder(10, BACK.y + 9, 4.2, BACK_H + 1, 3.2, s.P, 28), { lit: true });
lamp(s, [30, BACK.y + 9], BACK_H, { radius: 1.6 });

// The deck with its two answer buttons.
s.solid(slabOf(DECK, 0, DECK_H, s.P, 6, 1));
screws(s, corners(DECK, 7), DECK_H, 1.3);
for (const [x, pressed] of BUTTONS) {
	const y = DECK.y + DECK.d / 2;
	s.line(ring(x, y, 15, DECK_H, s.P, 40), { tone: "lo" });
	s.solid(cylinder(x, y, 13, DECK_H, 2, s.P, 40), { tone: "lo" });
	const stem = pressed ? 1 : 4;
	s.solid(cylinder(x, y, 7, DECK_H + 2, stem, s.P, 32));
	s.solid(
		cylinder(x, y, 11, DECK_H + 2 + stem, 4, s.P, 40, 1.2),
		pressed ? { lit: true } : {}
	);
}

export const drawing = cardDrawing(s);
