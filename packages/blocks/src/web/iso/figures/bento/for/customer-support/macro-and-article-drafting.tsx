import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Macro and article drafting: a rubber stamp on its ink pad. The same
 * question keeps coming in (the stack of blanks at the back), so it gets a
 * stamp of its own; the freshly stamped card (lit) is the new canned reply.
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const PAD = { x: -78, y: -16, w: 60, d: 46, r: 4 };
const PAD_H = 8;
const STAMP = { x: -66, y: -6, w: 36, d: 26, r: 2 };
const STAMP_Z = PAD_H;
const CENTER: [number, number] = [STAMP.x + STAMP.w / 2, STAMP.y + STAMP.d / 2];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CENTER[0], CENTER[1], 58],
]);

benchPlate(s, PLATE);
// Blank cards waiting at the back.
const blanks = { x: -30, y: -46, w: 40, d: 26, r: 1 };
s.halo(blanks, 0);
for (let i = 0; i < 5; i++) {
	s.solid(
		slabOf(
			{ ...blanks, x: blanks.x + (i % 2), y: blanks.y - (i % 3) },
			i * 2.4,
			2.4,
			s.P,
			1
		)
	);
}
// The ink pad with the stamp resting on it.
s.halo(PAD, 0);
s.solid(slabOf(PAD, 0, PAD_H, s.P, 4, 0.8));
s.line(planOutline(insetPlan(PAD, 4), PAD_H, s.P, 3), { tone: "lo" });
s.solid(slabOf(STAMP, STAMP_Z, 4, s.P, 2), { tone: "lo" });
s.solid(slabOf(insetPlan(STAMP, -1), STAMP_Z + 4, 8, s.P, 3, 0.8));
s.solid(cylinder(CENTER[0], CENTER[1], 5, STAMP_Z + 12, 20, s.P, 24));
s.solid(cylinder(CENTER[0], CENTER[1], 11, STAMP_Z + 32, 6, s.P, 36, 1.2), {
	tone: "lo",
});
s.solid(cylinder(CENTER[0], CENTER[1], 8, STAMP_Z + 38, 4, s.P, 32, 1.2));
// Stamped cards stacked in front right, the newest on top.
const card = { x: 18, y: -8, w: 56, d: 40, r: 1.5 };
s.halo(card, 0);
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf(
			{ ...card, x: card.x - i, y: card.y + (i % 2) },
			i * 2.4,
			2.4,
			s.P,
			1
		)
	);
}
const top = { ...card, x: card.x + 2, y: card.y + 2 };
s.solid(slabOf(top, 7.2, 2.4, s.P, 1), { lit: true });
const mark = { x: top.x + 8, y: top.y + 8, w: 26, d: 24, r: 1 };
s.line(planOutline(mark, 9.6, s.P, 2), { tone: "mid" });
s.line(
	lineOnTop([mark.x + 4, mark.y + 7], [mark.x + 20, mark.y + 7], 9.6, s.P),
	{
		tone: "mid",
	}
);
s.line(
	lineOnTop([mark.x + 4, mark.y + 13], [mark.x + 22, mark.y + 13], 9.6, s.P),
	{
		tone: "faint",
	}
);
s.line(
	lineOnTop([mark.x + 4, mark.y + 19], [mark.x + 16, mark.y + 19], 9.6, s.P),
	{
		tone: "faint",
	}
);
screws(s, [[PAD.x + 6, PAD.y + PAD.d - 6]], PAD_H, 1.2);

export const drawing = cardDrawing(s);
