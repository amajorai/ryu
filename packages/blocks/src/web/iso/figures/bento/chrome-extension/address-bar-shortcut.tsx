import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Address bar shortcut: a long bar housing with its entry slot, and in front a
 * key bed of three caps, the short word you type. Beside it, a three-way
 * selector: search, ask or run a skill. Its lever is thrown to one
 * position, and that position's lamp (the lit part) is on.
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const BAR = { x: -88, y: -40, w: 176, d: 24, r: 5 };
const BAR_H = 16;
const BED = { x: -84, y: -4, w: 90, d: 40, r: 4 };
const BED_H = 6;
const SELECT = { x: 18, y: -4, w: 66, d: 40, r: 4 };
const SEL_H = 8;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, -28, BAR_H + 4]]);

benchPlate(s, PLATE);
// The bar housing with its long entry slot and a caret at the start.
s.halo(BAR, 0);
s.solid(slabOf(BAR, 0, BAR_H, s.P, 6, 0.8));
const slot = { x: BAR.x + 22, y: BAR.y + 8, w: BAR.w - 34, d: 8, r: 2 };
s.solid(cylinder(BAR.x + 11, BAR.y + BAR.d / 2, 5, BAR_H, 2, s.P, 24), {
	tone: "lo",
});
s.line(planOutline(slot, BAR_H, s.P, 4), { tone: "mid" });
s.line(
	lineOnTop([slot.x + 4, slot.y + 4], [slot.x + 40, slot.y + 4], BAR_H, s.P),
	{ tone: "lo" }
);
s.solid(
	slabOf(
		{ x: slot.x + 43, y: slot.y + 1, w: 2.4, d: 6, r: 0.4 },
		BAR_H,
		3,
		s.P,
		2
	),
	{
		tone: "mid",
	}
);
// Key bed with three caps; the last one is pressed down.
s.halo(BED, 0);
s.solid(slabOf(BED, 0, BED_H, s.P, 6, 0.6), { tone: "lo" });
for (let i = 0; i < 3; i++) {
	const cap = { x: BED.x + 8 + i * 27, y: BED.y + 9, w: 22, d: 22, r: 3 };
	const h = i === 2 ? 4 : 9;
	s.solid(slabOf(cap, BED_H, h, s.P, 4, 1));
	s.line(planOutline(insetPlan(cap, 4), BED_H + h, s.P, 4), { tone: "faint" });
}
// Three-way selector: a lamp per route, and a lever in a gate slot.
s.halo(SELECT, 0);
s.solid(slabOf(SELECT, 0, SEL_H, s.P, 6, 0.8));
const gate = { x: SELECT.x + 10, y: SELECT.y + 8, w: 46, d: 6, r: 2 };
s.line(planOutline(gate, SEL_H, s.P, 4), { tone: "mid" });
const leverX = SELECT.x + 51;
s.solid(cylinder(leverX, gate.y + 3, 2, SEL_H, 12, s.P, 16));
s.solid(cylinder(leverX, gate.y + 3, 5, SEL_H + 12, 6, s.P, 24, 0.6));
// The lamps sit in front of the gate, so they are drawn after the lever.
const lampsY = SELECT.y + 30;
for (let i = 0; i < 3; i++) {
	lamp(s, [SELECT.x + 14 + i * 19, lampsY], SEL_H, {
		lit: i === 2,
		radius: 3.4,
	});
}
screws(
	s,
	[
		[SELECT.x + 6, SELECT.y + 6],
		[SELECT.x + SELECT.w - 6, SELECT.y + SELECT.d - 6],
	],
	SEL_H,
	1.3
);

export const drawing = cardDrawing(s);
