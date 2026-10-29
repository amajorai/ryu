import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	sideArc,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Separate keys: two locks on one bench with a wall between them. The square
 * admin lock takes a round-bowed key (the lit one); the round model lock takes
 * a different, square-bowed key. Neither key fits the other's keyway.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const ADMIN = { x: -78, y: -30, w: 56, d: 52, r: 5 };
const ADMIN_H = 24;
const WALL = { x: -6, y: -40, w: 10, d: 76, r: 2 };
const WALL_H = 26;
const DRUM: [number, number] = [46, -2];
const DRUM_R = 26;
const DRUM_H = 18;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-50, -4, ADMIN_H + 30],
	[DRUM[0], DRUM[1], DRUM_H + 30],
]);

/** A key standing in a keyway on a face at `z`, its bow on top. */
function key(
	[x, y]: [number, number],
	z: number,
	bow: "round" | "square",
	lit = false
) {
	s.solid(slabOf({ x: x - 2, y: y - 7, w: 4, d: 14, r: 0.5 }, z, 16, s.P, 2), {
		lit,
	});
	const top = z + 16;
	if (bow === "round") {
		s.solid(cylinder(x, y, 12, top, 4, s.P, 40, 0.5), { lit });
		s.line(ring(x, y, 4, top + 4, s.P, 20), { tone: "lo" });
	} else {
		s.solid(
			slabOf({ x: x - 11, y: y - 11, w: 22, d: 22, r: 2 }, top, 4, s.P, 3),
			{
				lit,
			}
		);
		s.line(
			planOutline({ x: x - 4, y: y - 4, w: 8, d: 8, r: 1 }, top + 4, s.P, 2),
			{
				tone: "lo",
			}
		);
	}
}

benchPlate(s, PLATE);
// Admin lock: a square block with its own keyway.
s.halo(ADMIN, 0);
s.solid(slabOf(ADMIN, 0, ADMIN_H, s.P, 6, 1));
s.line(planOutline(insetPlan(ADMIN, 5), ADMIN_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[ADMIN.x + 9, ADMIN.y + 9],
		[ADMIN.x + ADMIN.w - 9, ADMIN.y + ADMIN.d - 9],
	],
	ADMIN_H,
	1.6
);
lamp(s, [ADMIN.x + ADMIN.w - 10, ADMIN.y + 10], ADMIN_H, { radius: 1.8 });
s.line(planOutline({ x: -52, y: -12, w: 4, d: 16, r: 1 }, ADMIN_H, s.P, 2), {
	tone: "mid",
});
key([-50, -4], ADMIN_H, "round", true);
// The wall between them.
s.halo(WALL, 0);
s.solid(slabOf(WALL, 0, WALL_H, s.P, 3, 0.6));
// Model lock: a round drum with a cross keyway.
s.halo(
	{
		x: DRUM[0] - DRUM_R,
		y: DRUM[1] - DRUM_R,
		w: DRUM_R * 2,
		d: DRUM_R * 2,
		r: DRUM_R,
	},
	0
);
s.solid(cylinder(DRUM[0], DRUM[1], DRUM_R + 3, 0, 4, s.P, 56, 0.6), {
	tone: "lo",
});
s.solid(cylinder(DRUM[0], DRUM[1], DRUM_R, 4, DRUM_H - 4, s.P, 56, 0.8));
s.line(sideArc(DRUM[0], DRUM[1], DRUM_R, 11, s.P, 32), { tone: "faint" });
s.line(ring(DRUM[0], DRUM[1], DRUM_R - 6, DRUM_H, s.P, 48), { tone: "lo" });
s.line(
	planOutline(
		{ x: DRUM[0] - 2, y: DRUM[1] - 8, w: 4, d: 16, r: 1 },
		DRUM_H,
		s.P,
		2
	),
	{ tone: "mid" }
);
key([DRUM[0], DRUM[1]], DRUM_H, "square");

export const drawing = cardDrawing(s);
