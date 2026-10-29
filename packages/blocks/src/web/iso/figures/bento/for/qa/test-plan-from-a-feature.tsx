import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, knob, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Test plan from a feature: a card sorter. The spec sheet stands in the
 * reader's feed slot; the machine deals index cards into three bins in front,
 * the golden path, error states and boundaries. The newest card in the first
 * bin (the lit card) is where the plan starts.
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const READER = { x: -86, y: -38, w: 58, d: 56, r: 5 };
const READER_H = 30;
const BIN_H = 14;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-60, -20, READER_H + 22],
]);

function bin(x: number, cards: number, lit = false) {
	const plan = { x, y: -26, w: 26, d: 44, r: 3 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, BIN_H, s.P, 4, 0.6));
	s.line(planOutline(insetPlan(plan, 2.5), BIN_H, s.P, 3), { tone: "lo" });
	for (let i = 0; i < cards; i++) {
		const last = i === cards - 1;
		s.solid(
			slabOf(
				{ x: x + 4, y: plan.y + 8 + i * 7, w: 18, d: 1.6, r: 0.3 },
				4,
				BIN_H + (last ? 8 : 4),
				s.P,
				2
			),
			{ lit: lit && last, crease: "none" }
		);
	}
}

benchPlate(s, PLATE);
// The reader: a low housing with a feed slot on top.
s.halo(READER, 0);
s.solid(slabOf(READER, 0, READER_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(READER, 5), READER_H, s.P, 4), { tone: "faint" });
const slot = { x: -74, y: -22, w: 36, d: 4, r: 1 };
s.line(planOutline(slot, READER_H, s.P, 2), { tone: "mid" });
// The spec sheet standing in the slot, its text as rule lines.
s.solid(
	slabOf({ x: -72, y: -21, w: 32, d: 1.4, r: 0.3 }, READER_H, 20, s.P, 2),
	{ crease: "none" }
);
faceRules(s, "y", -19.6, -68, READER_H + 16, [24, 18, 22, 14], 3.4);
knob(s, [-74, 6], READER_H, 5, 5);
lamp(s, [-46, 8], READER_H, { radius: 1.8 });
lamp(s, [-38, 8], READER_H, { radius: 1.8 });
// The output shelf the bins sit on, then the three bins.
bin(-14, 3, true);
bin(18, 2);
bin(50, 4);

export const drawing = cardDrawing(s);
