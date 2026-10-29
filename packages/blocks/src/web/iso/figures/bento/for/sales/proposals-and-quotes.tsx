import {
	boxCorners,
	coil,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, knob, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Proposals and quotes: a binding press. Template sheets stand in the feed
 * slot on top; the press punches and coils them into a bound proposal, which
 * lies finished in front with its quote label on the cover (the lit part).
 */

const PLATE = { x: -100, y: -52, w: 200, d: 104, r: 8 };
const PRESS = { x: -88, y: -38, w: 70, d: 70, r: 5 };
const PRESS_H = 24;
const SLOT = { x: PRESS.x + 12, y: PRESS.y + 20, w: 46, d: 5, r: 1 };
const BOOK = { x: -2, y: -30, w: 86, d: 66, r: 3 };
const BOOK_H = 8;
const SPINE_X = BOOK.x + 6;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[SLOT.x, SLOT.y, PRESS_H + 30],
]);

benchPlate(s, PLATE);
// Press body with its feed slot, templates standing in it, and a side lever.
s.halo(PRESS, 0);
s.solid(slabOf(PRESS, 0, PRESS_H, s.P, 6, 1));
s.line(planOutline(SLOT, PRESS_H, s.P, 2), { tone: "mid" });
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf(
			{
				x: SLOT.x + 3 + i * 3,
				y: SLOT.y + 1 + i,
				w: SLOT.w - 6 - i * 6,
				d: 1.2,
				r: 0.3,
			},
			PRESS_H,
			26 - i * 5,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
knob(s, [PRESS.x + 18, PRESS.y + 50], PRESS_H, 6, 5);
lamp(s, [PRESS.x + 40, PRESS.y + 58], PRESS_H, { radius: 2 });
faceRules(s, "y", PRESS.y + PRESS.d, PRESS.x + 10, 16, [34, 22], 5);
// Press lever: a pivot boss with the arm laid back along the body.
const PIVOT: [number, number] = [PRESS.x + PRESS.w - 10, PRESS.y + 10];
s.solid(cylinder(PIVOT[0], PIVOT[1], 5, PRESS_H, 5, s.P, 24), { tone: "lo" });
s.solid(
	slabOf(
		{ x: PIVOT[0] - 2, y: PIVOT[1], w: 4, d: 40, r: 1 },
		PRESS_H + 5,
		3,
		s.P,
		2
	)
);
s.solid(cylinder(PIVOT[0], PIVOT[1] + 36, 3.5, PRESS_H + 8, 6, s.P, 24, 0.6));
// The bound proposal: page block, coil along the left edge, cover, label.
s.halo(BOOK, 0);
const spine = coil(
	BOOK.y + 6,
	BOOK.y + BOOK.d - 6,
	[SPINE_X, BOOK_H / 2 + 1],
	4.5,
	11,
	"y",
	s.P
);
s.line(spine.back, { tone: "lo" });
s.solid(slabOf(BOOK, 0, BOOK_H - 2, s.P, 3, 0.4));
const cover = { ...BOOK, x: BOOK.x - 0.5 };
s.solid(slabOf(cover, BOOK_H - 2, 2, s.P, 3), { tone: "lo", crease: "none" });
const label = { x: BOOK.x + 30, y: BOOK.y + 14, w: 40, d: 18, r: 2 };
s.solid(slabOf(label, BOOK_H, 1.4, s.P, 2), { lit: true, crease: "none" });
s.line(planOutline(insetPlan(BOOK, 6), BOOK_H, s.P, 2), { tone: "faint" });
s.line(
	lineOnTop([label.x, BOOK.y + 44], [label.x + 34, BOOK.y + 44], BOOK_H, s.P),
	{ tone: "lo" }
);
s.line(
	lineOnTop([label.x, BOOK.y + 51], [label.x + 22, BOOK.y + 51], BOOK_H, s.P),
	{ tone: "lo" }
);
s.line(spine.front, { tone: "mid" });

export const drawing = cardDrawing(s);
