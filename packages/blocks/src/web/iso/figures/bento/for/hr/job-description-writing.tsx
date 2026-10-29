import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, ruler, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Job description writing: the leveling framework as a stepped rack, one
 * step per level, tallest at the back. Each step has a card slot; the new
 * role's description card (the lit part) stands in the slot of the level it
 * was written to. The ruler along the front is the framework's scale.
 */

const PLATE = { x: -100, y: -48, w: 200, d: 96, r: 8 };
const STEPS = 5;
const STEP_W = 30;
const STEP_D = 56;
const RISE = 9;
const START_X = -82;
const STEP_Y = -34;
const PLACED = 2;
const CARD_H = 26;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[START_X, STEP_Y, STEPS * RISE + 2],
]);

benchPlate(s, PLATE);
s.halo({ x: START_X, y: STEP_Y, w: STEPS * STEP_W, d: STEP_D, r: 3 }, 0);
for (let i = 0; i < STEPS; i++) {
	const plan = {
		x: START_X + i * STEP_W,
		y: STEP_Y,
		w: STEP_W,
		d: STEP_D,
		r: 2,
	};
	const top = (STEPS - i) * RISE;
	s.solid(slabOf(plan, 0, top, s.P, 3, 0.6), { tone: i % 2 ? "mid" : "hi" });
	s.line(planOutline(insetPlan(plan, 4), top, s.P, 3), { tone: "faint" });
	const slot = { x: plan.x + 8, y: plan.y + 10, w: 4, d: 30, r: 1 };
	s.line(planOutline(slot, top, s.P, 2), { tone: "mid" });
	screws(s, [[plan.x + STEP_W / 2, plan.y + STEP_D - 7]], top, 1.3);
	if (i === PLACED) {
		const card = { x: slot.x + 0.6, y: slot.y + 1, w: 2.8, d: 28, r: 0.4 };
		s.solid(slabOf(card, top, CARD_H, s.P, 2), { lit: true });
		faceRules(
			s,
			"x",
			card.x + card.w,
			card.y + 4,
			top + CARD_H - 5,
			[20, 14, 18, 10],
			5
		);
	}
}
ruler(s, { x: START_X, y: 28, w: STEPS * STEP_W, d: 8, r: 1 }, 0);

export const drawing = cardDrawing(s);
