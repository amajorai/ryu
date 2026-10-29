import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Key vault: a strongbox on the bench. Your key goes in through the slot on
 * top (the lit key); the box hands agents only a token from the tray in
 * front, never the key itself.
 */

const PLATE = { x: -90, y: -52, w: 180, d: 104, r: 8 };
const BOX = { x: -54, y: -40, w: 80, d: 64, r: 5 };
const BOX_H = 40;
const DIAL: [number, number] = [-14, -8];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, BOX_H + 18]]);

benchPlate(s, PLATE);
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 8, 1.2));
s.line(planOutline(insetPlan(BOX, 5), BOX_H, s.P, 6), { tone: "faint" });
screws(
	s,
	[
		[BOX.x + 9, BOX.y + 9],
		[BOX.x + BOX.w - 9, BOX.y + BOX.d - 9],
	],
	BOX_H,
	1.6
);
// Combination dial on the top face.
s.solid(cylinder(DIAL[0], DIAL[1], 14, BOX_H, 2, s.P, 40), { tone: "lo" });
s.solid(cylinder(DIAL[0], DIAL[1], 11, BOX_H + 2, 5, s.P, 40));
s.line(knurl(DIAL[0], DIAL[1], 11, BOX_H + 2, BOX_H + 7, 36, s.P), {
	tone: "lo",
});
s.line(ring(DIAL[0], DIAL[1], 4, BOX_H + 7, s.P, 24), { tone: "mid" });
lamp(s, [BOX.x + BOX.w - 12, BOX.y + 10], BOX_H, { radius: 1.8 });
// The key going into the slot by the dial.
const slot = { x: 10, y: 4, w: 4, d: 18, r: 1 };
s.line(planOutline(slot, BOX_H, s.P, 2), { tone: "mid" });
s.solid(slabOf({ x: 10.5, y: 6, w: 3, d: 14, r: 0.5 }, BOX_H, 12, s.P, 2), {
	lit: true,
});
s.solid(cylinder(12, 13, 8, BOX_H + 12, 3, s.P, 32, 0.4), { lit: true });
// Token tray in front: what an agent actually gets.
const tray = { x: 40, y: 10, w: 34, d: 30, r: 3 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 5, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf({ x: 46, y: 18, w: 20, d: 12, r: 2 }, 5, 3, s.P, 3));

export const drawing = cardDrawing(s);
