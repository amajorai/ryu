import { boxCorners, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Consistency audit: a long card drawer, one card per page of the
 * manuscript, read front to back. Where a term or tense drifts, the card is
 * pulled up by its tab (the lit tab) so the location can be reported.
 */

const PLATE = { x: -100, y: -44, w: 200, d: 88, r: 8 };
const DRAWER = { x: -82, y: -20, w: 150, d: 40, r: 3 };
const WALL = 3;
const WALL_H = 16;
const CARD_H = 24;
const CARDS = 14;
const FLAGGED = 8;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, CARD_H + 22]]);

benchPlate(s, PLATE);
// Runners under the drawer.
s.solid(slabOf({ x: -88, y: -16, w: 146, d: 5, r: 1 }, 0, 2, s.P, 2), {
	tone: "lo",
});
s.halo(DRAWER, 2);
s.solid(slabOf(DRAWER, 2, 3, s.P, 4, 0.4));
// Back wall and rear end panel.
s.solid(
	slabOf(
		{ x: DRAWER.x, y: DRAWER.y, w: DRAWER.w, d: WALL, r: 1 },
		5,
		WALL_H,
		s.P,
		2
	)
);
s.solid(
	slabOf(
		{ x: DRAWER.x, y: DRAWER.y, w: WALL, d: DRAWER.d, r: 1 },
		5,
		WALL_H,
		s.P,
		2
	)
);
// Cards, back to front; the flagged one rides up on its tab.
for (let i = 0; i < CARDS; i++) {
	const x = DRAWER.x + 10 + i * 9.2;
	const lift = i === FLAGGED ? 8 : 0;
	s.solid(
		slabOf(
			{ x, y: DRAWER.y + WALL + 2, w: 1.6, d: DRAWER.d - 2 * WALL - 4, r: 0.3 },
			5,
			CARD_H + lift,
			s.P,
			2
		),
		{ crease: "none" }
	);
	if (i === FLAGGED) {
		s.solid(
			slabOf(
				{ x: x - 0.4, y: DRAWER.y + WALL + 6, w: 2.8, d: 14, r: 0.8 },
				5 + CARD_H + lift,
				7,
				s.P,
				2
			),
			{ lit: true, crease: "none" }
		);
	}
}
// Front wall, then the drawer front with its pull and label frame.
s.solid(
	slabOf(
		{ x: DRAWER.x, y: DRAWER.y + DRAWER.d - WALL, w: DRAWER.w, d: WALL, r: 1 },
		5,
		WALL_H,
		s.P,
		2
	)
);
const end = DRAWER.x + DRAWER.w;
s.solid(
	slabOf(
		{ x: end - 5, y: DRAWER.y - 2, w: 5, d: DRAWER.d + 4, r: 1.5 },
		2,
		WALL_H + 8,
		s.P,
		3,
		0.6
	)
);
s.line(faceRect(s, "x", end, DRAWER.y + 11, DRAWER.y + 29, 16, 22), {
	tone: "lo",
});
s.solid(slabOf({ x: end, y: -7, w: 3, d: 14, r: 1 }, 9, 4, s.P, 2), {
	tone: "lo",
});
lamp(s, [end - 2.5, DRAWER.y + DRAWER.d - 2], WALL_H + 10, { radius: 1.4 });

export const drawing = cardDrawing(s);
