import {
	boxCorners,
	cylinder,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, ruler } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Tone and length rewrites: a paper trimmer. The approved line lies against
 * the fence with its end under the blade arm; the stop block (the lit part)
 * on the ruler sets the length. Shorter cuts lie in front, and the knob
 * picks the register.
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const BOARD = { x: -84, y: -44, w: 156, d: 86, r: 4 };
const TOP = 5;
const BLADE_X = 54;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [BLADE_X, 30, 24]]);

function strip(x0: number, x1: number, y: number, rules: number) {
	s.solid(slabOf({ x: x0, y, w: x1 - x0, d: 14, r: 0.5 }, TOP, 1.2, s.P, 2), {
		crease: "none",
	});
	s.line(lineOnTop([x0 + 6, y + 7], [x0 + 6 + rules, y + 7], TOP + 1.2, s.P), {
		tone: "mid",
	});
}

benchPlate(s, PLATE);
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, TOP, s.P, 6, 0.8));
ruler(s, { x: BOARD.x + 6, y: BOARD.y + 3, w: 130, d: 8, r: 1 }, TOP);
// Fence along the back, with the stop block clamped to it.
s.solid(slabOf({ x: BOARD.x + 6, y: -31, w: 130, d: 4, r: 1 }, TOP, 6, s.P, 2));
s.solid(slabOf({ x: -42, y: -33, w: 8, d: 20, r: 1.5 }, TOP, 9, s.P, 3), {
	lit: true,
});
strip(-34, BLADE_X + 6, -27, 70);
strip(-34, 18, -4, 40);
strip(-34, -4, 18, 20);
knob(s, [-62, 18], TOP, 7, 6);
// Blade arm, pivot at the back, handle at the front.
s.solid(cylinder(BLADE_X + 4, -36, 7, TOP, 6, s.P, 28), { tone: "lo" });
s.solid(slabOf({ x: BLADE_X, y: -40, w: 8, d: 74, r: 2 }, TOP + 1, 5, s.P, 3));
s.solid(cylinder(BLADE_X + 4, 28, 5, TOP + 6, 12, s.P, 24), { tone: "lo" });
s.solid(cylinder(BLADE_X + 4, 28, 6.5, TOP + 18, 2, s.P, 24));

export const drawing = cardDrawing(s);
