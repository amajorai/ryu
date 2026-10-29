import {
	boxCorners,
	cylinder,
	knurl,
	lineOnTop,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Signed webhooks: an incoming envelope closed with a wax seal (the lit
 * part), the seal stamp that made it standing beside a stick of wax. Replies
 * and delivery results arrive sealed, so you can tell they came from us.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const ENVELOPE = { x: -78, y: -34, w: 96, d: 64, r: 2 };
const STAMP: [number, number] = [56, -12];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [56, -12, 52]]);

benchPlate(s, PLATE);
// A second envelope under the first, then the sealed one on top.
const under = { ...ENVELOPE, x: ENVELOPE.x + 6, y: ENVELOPE.y - 8 };
s.halo(under, 0);
s.solid(slabOf(under, 0, 2.5, s.P, 3), { tone: "lo", crease: "none" });
s.halo(ENVELOPE, 2.5);
s.solid(slabOf(ENVELOPE, 2.5, 2.5, s.P, 3), { crease: "none" });
const top = 5;
const centre: [number, number] = [ENVELOPE.x + ENVELOPE.w / 2, ENVELOPE.y + 36];
s.line(
	lineOnTop([ENVELOPE.x + 1, ENVELOPE.y + 1], centre, top, s.P) +
		lineOnTop(centre, [ENVELOPE.x + ENVELOPE.w - 1, ENVELOPE.y + 1], top, s.P),
	{ tone: "mid" }
);
s.line(
	lineOnTop(
		[ENVELOPE.x + 1, ENVELOPE.y + ENVELOPE.d - 1],
		[ENVELOPE.x + 34, ENVELOPE.y + 40],
		top,
		s.P
	) +
		lineOnTop(
			[ENVELOPE.x + ENVELOPE.w - 1, ENVELOPE.y + ENVELOPE.d - 1],
			[ENVELOPE.x + ENVELOPE.w - 34, ENVELOPE.y + 40],
			top,
			s.P
		),
	{ tone: "faint" }
);
s.solid(cylinder(centre[0], centre[1], 11, top, 2.5, s.P, 36, 0.6), {
	lit: true,
});
s.line(ring(centre[0], centre[1], 6.5, top + 2.5, s.P, 28), { tone: "hi" });
// The seal stamp: die, collar, neck and a knurled handle.
s.halo({ x: STAMP[0] - 13, y: STAMP[1] - 13, w: 26, d: 26, r: 13 }, 0);
s.solid(cylinder(STAMP[0], STAMP[1], 12, 0, 5, s.P, 40, 0.6), { tone: "lo" });
s.solid(cylinder(STAMP[0], STAMP[1], 8, 5, 3, s.P, 32));
s.solid(cylinder(STAMP[0], STAMP[1], 3.5, 8, 14, s.P, 20));
s.solid(cylinder(STAMP[0], STAMP[1], 7, 22, 22, s.P, 32, 0.8));
s.line(knurl(STAMP[0], STAMP[1], 7, 26, 40, 28, s.P), { tone: "faint" });
s.solid(cylinder(STAMP[0], STAMP[1], 5, 44, 4, s.P, 28, 1), { tone: "lo" });
// A stick of sealing wax lying in front.
const wax = { x: 32, y: 24, w: 52, d: 8, r: 3.5 };
s.halo(wax, 0);
s.solid(slabOf(wax, 0, 7, s.P, 4, 0.8), { tone: "lo" });
s.solid(cylinder(wax.x + wax.w - 2, wax.y + 4, 1, 7, 3, s.P, 12));

export const drawing = cardDrawing(s);
