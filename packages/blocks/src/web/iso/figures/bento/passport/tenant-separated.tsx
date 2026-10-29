import { boxCorners, cylinder, knurl, slabOf } from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Tenant-separated: a cubby shelf of three bays split by solid walls, each
 * bay holding its own small safe with its own dial. One tenant's safe is in
 * use (the lit lamp); the walls keep it apart from its neighbours.
 */

const PLATE = { x: -98, y: -46, w: 196, d: 90, r: 8 };
const SHELF = { x: -86, y: -34, w: 172, d: 66, r: 3 };
const SHELF_H = 6;
const WALL_H = 18;
const BAY = 52;
const WALL = 6;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, -34, SHELF_H + 32],
]);

function safe(x0: number, lit: boolean) {
	const plan = { x: x0 + 9, y: -16, w: 34, d: 36, r: 3 };
	const height = 26;
	const top = SHELF_H + height;
	s.halo(plan, SHELF_H);
	s.solid(slabOf(plan, SHELF_H, height, s.P, 4, 0.8));
	// Door seam and handle on the front face.
	const front = plan.y + plan.d;
	s.line(
		faceRect(
			s,
			"y",
			front,
			plan.x + 4,
			plan.x + plan.w - 4,
			SHELF_H + 3,
			top - 3
		),
		{ tone: "mid" }
	);
	s.solid(
		slabOf(
			{ x: plan.x + plan.w - 11, y: front, w: 3, d: 2.4, r: 0.6 },
			SHELF_H + 8,
			10,
			s.P,
			1
		),
		{ tone: "lo" }
	);
	const dial: [number, number] = [plan.x + 14, plan.y + 20];
	s.solid(cylinder(dial[0], dial[1], 7, top, 1.2, s.P, 28), { tone: "lo" });
	s.solid(cylinder(dial[0], dial[1], 5, top + 1.2, 3, s.P, 28));
	s.line(knurl(dial[0], dial[1], 5, top + 1.2, top + 4.2, 24, s.P), {
		tone: "lo",
	});
	lamp(s, [plan.x + plan.w - 6, plan.y + 6], top, { lit, radius: 2.6 });
	screws(s, [[plan.x + 5, plan.y + plan.d - 5]], top, 1.2);
}

function wall(x: number) {
	s.solid(
		slabOf(
			{ x, y: SHELF.y + 4, w: WALL, d: SHELF.d - 4, r: 1 },
			SHELF_H,
			WALL_H,
			s.P,
			2,
			0.4
		)
	);
}

benchPlate(s, PLATE);
s.halo(SHELF, 0);
s.solid(slabOf(SHELF, 0, SHELF_H, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf({ ...SHELF, d: 4, r: 1 }, SHELF_H, WALL_H, s.P, 2, 0.4), {
	tone: "lo",
});
wall(SHELF.x);
safe(SHELF.x + WALL, false);
wall(SHELF.x + WALL + BAY);
safe(SHELF.x + 2 * WALL + BAY, true);
wall(SHELF.x + WALL * 2 + BAY * 2);
safe(SHELF.x + 3 * WALL + BAY * 2, false);
wall(SHELF.x + SHELF.w - WALL);

export const drawing = cardDrawing(s);
