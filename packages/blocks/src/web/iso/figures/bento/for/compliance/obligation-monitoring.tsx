import { boxCorners, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Obligation monitoring: a tickler file. Each obligation is a divider in a
 * dated card box, filed in order; the tab standing up at the front of the
 * run (the lit part) is the next deadline coming due. A setting knob and a
 * lamp sit on the clock block beside it.
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const BOX = { x: -74, y: -34, w: 112, d: 64, r: 3 };
const WALL = 3;
const WALL_H = 16;
const DIVIDERS = 11;
const DIV_H = 28;
const TAB_H = 6;
const CLOCK = { x: 50, y: -10, w: 30, d: 34, r: 4 };
const NEXT = 8;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, 0, DIV_H + TAB_H + 4],
]);

benchPlate(s, PLATE);
s.halo(BOX, 0);
// Base, then the back and left walls behind the cards.
s.solid(slabOf(BOX, 0, 3, s.P, 3, 0.6), { tone: "lo" });
s.solid(
	slabOf({ x: BOX.x, y: BOX.y, w: BOX.w, d: WALL, r: 1 }, 3, WALL_H, s.P, 2)
);
s.solid(
	slabOf({ x: BOX.x, y: BOX.y, w: WALL, d: BOX.d, r: 1 }, 3, WALL_H, s.P, 2)
);
for (let i = 0; i < DIVIDERS; i++) {
	const x = BOX.x + 8 + i * 9.4;
	const lit = i === NEXT;
	const height = lit ? DIV_H + 4 : DIV_H;
	s.solid(
		slabOf(
			{ x, y: BOX.y + WALL + 2, w: 1.6, d: BOX.d - WALL * 2 - 4, r: 0.4 },
			3,
			height - 3,
			s.P,
			2
		),
		{ crease: "none" }
	);
	const tabY = BOX.y + WALL + 4 + (i % 4) * 13;
	s.solid(
		slabOf({ x, y: tabY, w: 1.6, d: 11, r: 0.4 }, height, TAB_H, s.P, 2),
		{
			lit,
			tone: "lo",
			crease: "none",
		}
	);
}
// Front and right walls, in front of the cards.
s.solid(
	slabOf(
		{ x: BOX.x + BOX.w - WALL, y: BOX.y, w: WALL, d: BOX.d, r: 1 },
		3,
		WALL_H,
		s.P,
		2
	)
);
s.solid(
	slabOf(
		{ x: BOX.x, y: BOX.y + BOX.d - WALL, w: BOX.w, d: WALL, r: 1 },
		3,
		WALL_H,
		s.P,
		2
	)
);
s.solid(
	slabOf(
		{ x: BOX.x + BOX.w / 2 - 10, y: BOX.y + BOX.d, w: 20, d: 3, r: 1 },
		7,
		4,
		s.P,
		2
	),
	{
		tone: "lo",
	}
);
// The clock block that sets the schedule.
s.halo(CLOCK, 0);
s.solid(slabOf(CLOCK, 0, 12, s.P, 4, 0.8));
knob(s, [CLOCK.x + 15, CLOCK.y + 12], 12, 6, 5);
lamp(s, [CLOCK.x + 15, CLOCK.y + 27], 12, { radius: 1.8 });

export const drawing = cardDrawing(s);
