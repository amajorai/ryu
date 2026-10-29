import { boxCorners, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Quote comparison: a slotted rack holding three supplier quotes upright,
 * side by side, so they read against each other line for line. The middle
 * quote, the best one, stands raised in its slot (the lit card).
 */

const PLATE = { x: -100, y: -46, w: 200, d: 92, r: 8 };
const RACK = { x: -84, y: -20, w: 168, d: 34, r: 4 };
const RACK_H = 8;
const CARD_W = 44;
const CARD_D = 4;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, -10, 62]]);

function quote(x: number, lift: number, lit = false) {
	const plan = { x: x - CARD_W / 2, y: -6, w: CARD_W, d: CARD_D, r: 0.8 };
	const height = 40 + lift;
	s.solid(slabOf(plan, RACK_H - 4, height, s.P, 2), { lit });
	const front = plan.y + plan.d;
	const top = RACK_H - 4 + height;
	faceRules(s, "y", front, plan.x + 6, top - 7, [28, 22, 30, 18, 26], 5);
}

benchPlate(s, PLATE);
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 6, 0.8));
screws(
	s,
	[
		[RACK.x + 7, RACK.y + 7],
		[RACK.x + RACK.w - 7, RACK.y + RACK.d - 7],
	],
	RACK_H,
	1.4
);
quote(-54, 0);
quote(0, 10, true);
quote(54, -6);
// Pointer lamps along the front lip, one per slot.
lamp(s, [-54, RACK.y + RACK.d - 6], RACK_H, { radius: 1.8 });
lamp(s, [0, RACK.y + RACK.d - 6], RACK_H, { radius: 1.8 });
lamp(s, [54, RACK.y + RACK.d - 6], RACK_H, { radius: 1.8 });
// A paperweight block resting on the plate in front.
const weight = { x: 60, y: 22, w: 26, d: 14, r: 3 };
s.halo(weight, 0);
s.solid(slabOf(weight, 0, 6, s.P, 4, 0.8), { tone: "lo" });

export const drawing = cardDrawing(s);
