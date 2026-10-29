import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";
import { house } from "./house.ts";

/*
 * Buyer matching: a shape sorter. The lid has one opening per active listing;
 * the buyer's criteria are a house-shaped block that only drops into the
 * listing it fits (the lit house, seated in its opening). The pieces that do not fit wait on
 * the bench.
 */

const PLATE = { x: -100, y: -52, w: 200, d: 104, r: 8 };
const BOX = { x: -80, y: -38, w: 92, d: 70, r: 5 };
const BOX_H = 28;
const SQUARE = { x: -42, y: -8, w: 24, d: 24, r: 1 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners(BOX, 0, BOX_H),
	[-30, 4, BOX_H + 24],
]);

benchPlate(s, PLATE);
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BOX, 4), BOX_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[BOX.x + 9, BOX.y + 9],
		[BOX.x + BOX.w - 9, BOX.y + 9],
		[BOX.x + 9, BOX.y + BOX.d - 9],
		[BOX.x + BOX.w - 9, BOX.y + BOX.d - 9],
	],
	BOX_H,
	1.4
);
// Openings: round, two slots, and the square one the house fits.
s.line(ring(-2, 12, 8, BOX_H, s.P, 32), { tone: "mid" });
s.line(planOutline({ x: -18, y: -28, w: 22, d: 8, r: 3 }, BOX_H, s.P, 4), {
	tone: "mid",
});
s.line(planOutline({ x: -66, y: 4, w: 10, d: 18, r: 5 }, BOX_H, s.P, 4), {
	tone: "mid",
});
s.line(planOutline(SQUARE, BOX_H, s.P, 1), { tone: "mid" });
house(s, insetPlan(SQUARE, 3), 12, { rise: 8, lit: true, z: BOX_H });
// Pieces that do not fit, waiting on the bench.
s.halo({ x: 26, y: -30, w: 24, d: 24, r: 12 }, 0);
s.solid(cylinder(38, -18, 11, 0, 14, s.P, 40, 0.6));
s.halo({ x: 30, y: 14, w: 40, d: 12, r: 5 }, 0);
s.solid(slabOf({ x: 30, y: 14, w: 40, d: 12, r: 5 }, 0, 12, s.P, 6, 0.6));

export const drawing = cardDrawing(s);
