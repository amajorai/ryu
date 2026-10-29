import {
	boxCorners,
	cylinder,
	knurl,
	lineOnTop,
	radialTicks,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Product and feature naming: a label embosser. The character wheel on top
 * spells a name, the tape feeds from the reel behind, and the freshly cut
 * name tag (the lit part) lies at the exit; earlier candidates wait in the
 * tray, each with a line of rationale.
 */

const PLATE = { x: -100, y: -56, w: 200, d: 112, r: 8 };
const BODY = { x: -62, y: -34, w: 76, d: 58, r: 8 };
const BODY_H = 16;
const WHEEL: [number, number] = [-26, -5];
const TAPE_X = -34;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-26, -5, BODY_H + 12],
]);

benchPlate(s, PLATE);
// Tape reel standing behind the body.
s.halo({ x: -92, y: -48, w: 28, d: 28, r: 14 }, 0);
s.solid(cylinder(-78, -34, 13, 0, 3, s.P, 36), { tone: "lo" });
s.solid(cylinder(-78, -34, 11, 3, 8, s.P, 36));
s.line(ring(-78, -34, 4, 11, s.P, 20), { tone: "lo" });
s.halo(BODY, 0);
s.solid(slabOf(BODY, 0, BODY_H, s.P, 8, 1.2));
// Character wheel: a ticked dial with a knurled hub.
s.solid(cylinder(WHEEL[0], WHEEL[1], 22, BODY_H, 3, s.P, 48, 0.6), {
	tone: "lo",
});
const ticks = radialTicks(
	WHEEL[0],
	WHEEL[1],
	20,
	36,
	6,
	BODY_H + 3,
	[3, 6],
	s.P
);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
s.solid(cylinder(WHEEL[0], WHEEL[1], 8, BODY_H + 3, 6, s.P, 32));
s.line(knurl(WHEEL[0], WHEEL[1], 8, BODY_H + 3, BODY_H + 9, 28, s.P), {
	tone: "lo",
});
s.line(lineOnTop(WHEEL, [WHEEL[0] + 6, WHEEL[1]], BODY_H + 9, s.P), {
	tone: "hi",
});
// Squeeze lever along the right side.
s.solid(
	slabOf({ x: BODY.x + BODY.w, y: -14, w: 30, d: 12, r: 2 }, 6, 6, s.P, 3)
);
s.solid(cylinder(BODY.x + BODY.w + 30, -8, 6, 2, 14, s.P, 24), { tone: "lo" });
screws(s, [[BODY.x + 10, BODY.y + BODY.d - 8]], BODY_H, 1.6);
// Tape out of the front slot, and the cut tag beyond it.
s.solid(
	slabOf({ x: TAPE_X, y: BODY.y + BODY.d, w: 12, d: 10, r: 0.5 }, 0, 1, s.P, 2),
	{
		tone: "lo",
		crease: "none",
	}
);
s.solid(slabOf({ x: TAPE_X - 2, y: 38, w: 16, d: 12, r: 1.5 }, 0, 2, s.P, 3), {
	lit: true,
});
// Candidate tray.
const tray = { x: 26, y: 8, w: 56, d: 38, r: 3 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 4, s.P, 4, 0.6));
for (let i = 0; i < 3; i++) {
	const y = tray.y + 5 + i * 10.5;
	s.solid(slabOf({ x: tray.x + 6, y, w: 44, d: 8, r: 1 }, 4, 1.6, s.P, 2), {
		crease: "none",
	});
	s.line(
		lineOnTop([tray.x + 10, y + 4], [tray.x + 30 + i * 4, y + 4], 5.6, s.P),
		{
			tone: "lo",
		}
	);
}

export const drawing = cardDrawing(s);
