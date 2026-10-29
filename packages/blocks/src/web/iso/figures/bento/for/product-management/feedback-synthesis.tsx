import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Feedback synthesis: a sorting hopper. Mixed slips (tickets, reviews, call
 * notes) are poured in at the back and ride the feed rail out into three
 * theme bins; the pile in each bin is how often that theme came up, and the
 * top slip of the biggest pile (lit) is the quote that stands for it.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const HOPPER = { x: -84, y: -44, w: 44, d: 40, r: 4 };
const HOPPER_H = 38;
const RAIL = { x: -40, y: -34, w: 120, d: 16, r: 2 };
const RAIL_H = 6;
const BIN_Y = -8;
const BIN_D = 38;
const BIN_H = 8;
const SLIP_H = 2.6;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[HOPPER.x - 3, HOPPER.y - 3, HOPPER_H + 12],
]);

/** A theme bin: an open tray holding a pile of `count` slips. */
function bin(x: number, count: number) {
	const tray = { x, y: BIN_Y, w: 38, d: BIN_D, r: 3 };
	s.halo(tray, 0);
	s.solid(slabOf(tray, 0, BIN_H, s.P, 4, 0.6), { tone: "lo" });
	s.line(planOutline(insetPlan(tray, 3), BIN_H, s.P, 3), { tone: "faint" });
	for (let i = 0; i < count; i++) {
		const shift = i % 2 === 0 ? 0 : 1.5;
		const slip = { x: x + 6 + shift, y: BIN_Y + 7, w: 26, d: 24, r: 1 };
		s.solid(slabOf(slip, BIN_H - 4 + i * SLIP_H, SLIP_H, s.P, 2), {
			crease: "none",
			lit: count === 6 && i === count - 1,
		});
	}
	const top = BIN_H - 4 + count * SLIP_H;
	const rule = (count === 6 ? "mid" : "lo") as "mid" | "lo";
	s.line(lineOnTop([x + 10, BIN_Y + 13], [x + 24, BIN_Y + 13], top, s.P), {
		tone: rule,
	});
	s.line(lineOnTop([x + 10, BIN_Y + 18], [x + 20, BIN_Y + 18], top, s.P), {
		tone: "faint",
	});
	s.line(faceRect(s, "y", BIN_Y + BIN_D, x + 10, x + 24, 2.5, 5.5), {
		tone: "lo",
	});
}

benchPlate(s, PLATE);
// The hopper: a body with a flared mouth, open on top, slips sticking out.
const MOUTH = {
	x: HOPPER.x - 3,
	y: HOPPER.y - 3,
	w: HOPPER.w + 6,
	d: HOPPER.d + 6,
	r: 5,
};
const MOUTH_Z = HOPPER_H - 10;
s.halo(HOPPER, 0);
s.solid(slabOf(HOPPER, 0, MOUTH_Z, s.P, 4, 1));
s.solid(slabOf(MOUTH, MOUTH_Z, HOPPER_H - MOUTH_Z, s.P, 4, 0.8));
s.solid(slabOf(insetPlan(MOUTH, 4), HOPPER_H - 0.6, 0.6, s.P, 3), {
	tone: "lo",
	crease: "none",
});
for (const [x, y, h] of [
	[-78, -38, 10],
	[-66, -30, 7],
] as const) {
	s.solid(slabOf({ x, y, w: 16, d: 2, r: 0 }, HOPPER_H, h, s.P, 1), {
		crease: "none",
	});
}
s.line(
	faceRect(s, "y", HOPPER.y + HOPPER.d, HOPPER.x + 10, HOPPER.x + 34, 6, 12),
	{
		tone: "lo",
	}
);
// Feed rail running out of the hopper's flank along the back of the bins.
s.solid(slabOf(RAIL, 0, RAIL_H, s.P, 3, 0.6));
s.line(lineOnTop([RAIL.x + 4, -26], [RAIL.x + RAIL.w - 4, -26], RAIL_H, s.P), {
	tone: "lo",
});
screws(
	s,
	[
		[RAIL.x + RAIL.w - 6, -26],
		[RAIL.x + 50, -26],
	],
	RAIL_H,
	1.3
);
for (const x of [-12, 14, 40]) {
	s.solid(slabOf({ x, y: -31, w: 12, d: 10, r: 1 }, RAIL_H, 2, s.P, 2), {
		crease: "none",
	});
}
knob(s, [86, -40], 0, 4, 4);
bin(-40, 2);
bin(2, 6);
bin(44, 4);

export const drawing = cardDrawing(s);
