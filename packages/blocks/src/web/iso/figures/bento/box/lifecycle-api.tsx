import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, jack, knob, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Lifecycle API: a control desk with four push keys in a row (create, run,
 * stop, delete). The run key is pressed down (the lit key); the key switch on
 * its own post beside the desk is where Ryu Core can take the controls.
 */

const PLATE = { x: -96, y: -48, w: 192, d: 96, r: 8 };
const DESK = { x: -80, y: -32, w: 130, d: 58, r: 5 };
const DESK_H = 16;
const KEY = 20;
const PRESSED = 1;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [70, 0, 36]]);

benchPlate(s, PLATE);
s.halo(DESK, 0);
s.solid(slabOf(DESK, 0, DESK_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(DESK, 4), DESK_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[DESK.x + 7, DESK.y + 7],
		[DESK.x + DESK.w - 7, DESK.y + 7],
	],
	DESK_H,
	1.4
);
for (let i = 0; i < 4; i++) {
	const x = DESK.x + 10 + i * 28;
	const well = { x: x - 2, y: -18, w: KEY + 4, d: KEY + 4, r: 3 };
	s.solid(slabOf(well, DESK_H, 1, s.P, 4), { tone: "lo" });
	const pressed = i === PRESSED;
	s.solid(
		slabOf(
			{ x, y: -16, w: KEY, d: KEY, r: 2.5 },
			DESK_H + 1,
			pressed ? 2 : 7,
			s.P,
			4,
			0.6
		),
		{ lit: pressed }
	);
	lamp(s, [x + KEY / 2, DESK.y + DESK.d - 7], DESK_H, { radius: 1.6 });
}
// Key switch on its own post: the hand Ryu Core can put on the desk.
const POST = { x: 58, y: -14, w: 26, d: 28, r: 4 };
s.halo(POST, 0);
s.solid(slabOf(POST, 0, 22, s.P, 4, 0.8));
s.solid(cylinder(71, 0, 9, 22, 2, s.P, 32), { tone: "lo" });
knob(s, [71, 0], 24, 6, 8);
jack(s, [DESK.x + DESK.w - 8, DESK.y + DESK.d - 7], DESK_H);

export const drawing = cardDrawing(s);
