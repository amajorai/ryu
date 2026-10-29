import {
	boxCorners,
	cylinder,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Backlog grooming: a ticket file. Cards stand on end in a long tray, held
 * by a follower block; the newly groomed card (lit) is lifted to be read and
 * rewritten, while the duplicate it matched lies in the reject tray beside.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const TRAY = { x: -84, y: -28, w: 116, d: 44, r: 3 };
const WALL_H = 12;
const CARD_D = 36;
const CARD_H = 26;
const REJECT = { x: 46, y: -22, w: 38, d: 40, r: 3 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-20, -24, 52]]);

benchPlate(s, PLATE);
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 3, s.P, 3, 0.6), { tone: "lo" });
// Far wall, then the guide rod the cards ride on.
s.solid(slabOf({ ...TRAY, d: 3 }, 3, WALL_H, s.P, 2));
s.solid(slabOf({ ...TRAY, w: 3 }, 3, WALL_H, s.P, 2));
s.line(lineOnTop([TRAY.x + 4, -6], [TRAY.x + TRAY.w - 4, -6], 3, s.P), {
	tone: "mid",
});
for (let i = 0; i < 9; i++) {
	const x = TRAY.x + 10 + i * 9;
	const lit = i === 6;
	const card = { x, y: TRAY.y + 5, w: 1.8, d: CARD_D, r: 0 };
	s.solid(slabOf(card, 3, lit ? CARD_H + 20 : CARD_H, s.P, 1), { lit });
	if (!lit && i % 3 === 0) {
		s.solid(
			slabOf(
				{ x: x - 0.5, y: TRAY.y + 8, w: 2.8, d: 6, r: 0 },
				3 + CARD_H,
				3,
				s.P,
				1
			),
			{ tone: "lo" }
		);
	}
}
// Follower block pressing the stack, on its knob.
const follower = { x: TRAY.x + 92, y: TRAY.y + 4, w: 8, d: CARD_D + 2, r: 1 };
s.solid(slabOf(follower, 3, 20, s.P, 2, 0.4));
s.solid(cylinder(follower.x + 4, -6, 3, 23, 4, s.P, 20), { tone: "lo" });
s.solid(slabOf({ ...TRAY, x: TRAY.x + TRAY.w - 3, w: 3 }, 3, WALL_H, s.P, 2));
s.solid(slabOf({ ...TRAY, y: TRAY.y + TRAY.d - 3, d: 3 }, 3, WALL_H, s.P, 2));
s.line(faceRect(s, "y", TRAY.y + TRAY.d, TRAY.x + 46, TRAY.x + 70, 6, 12), {
	tone: "lo",
});
// Reject tray: the duplicate, set aside flat.
s.halo(REJECT, 0);
s.solid(slabOf(REJECT, 0, 6, s.P, 3, 0.6), { tone: "lo" });
s.solid(slabOf({ x: 52, y: -16, w: 26, d: 24, r: 1 }, 4, 2, s.P, 2), {
	crease: "none",
});
s.solid(slabOf({ x: 54, y: -12, w: 26, d: 24, r: 1 }, 6, 2, s.P, 2), {
	crease: "none",
});
s.line(lineOnTop([58, -4], [74, 10], 8, s.P), { tone: "mid" });
s.line(lineOnTop([74, -4], [58, 10], 8, s.P), { tone: "mid" });
screws(
	s,
	[
		[REJECT.x + 5, REJECT.y + REJECT.d - 5],
		[REJECT.x + REJECT.w - 5, REJECT.y + REJECT.d - 5],
	],
	6,
	1.1
);

export const drawing = cardDrawing(s);
