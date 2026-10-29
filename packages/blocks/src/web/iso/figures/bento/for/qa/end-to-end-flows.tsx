import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * End-to-end flows: a tapping robot. A phone lies in its cradle while an arm
 * on a column walks a stylus through the journey, one tap at a time; the lit
 * button under the stylus is the step it is pressing now.
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const CRADLE = { x: -36, y: -44, w: 66, d: 88, r: 5 };
const PHONE = { x: -28, y: -38, w: 50, d: 76, r: 7 };
const PHONE_Z = 4;
const SCREEN_Z = PHONE_Z + 5;
const COLUMN: [number, number] = [-70, -4];
const ARM_Z = 50;
const TAP: [number, number] = [-3, -4];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[COLUMN[0], COLUMN[1], ARM_Z + 8],
]);

benchPlate(s, PLATE);
// The column at the back left, rising from a round foot.
s.halo({ x: -82, y: -16, w: 24, d: 24, r: 12 }, 0);
s.solid(cylinder(COLUMN[0], COLUMN[1], 12, 0, 4, s.P, 32, 0.6), { tone: "lo" });
s.solid(cylinder(COLUMN[0], COLUMN[1], 6, 4, ARM_Z - 4, s.P, 28));
// Cradle and the phone in it.
s.halo(CRADLE, 0);
s.solid(slabOf(CRADLE, 0, PHONE_Z, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(PHONE, PHONE_Z, 5, s.P, 6, 0.8));
const screen = insetPlan(PHONE, 4);
s.line(planOutline(screen, SCREEN_Z, s.P, 6), { tone: "lo" });
for (const [i, span] of [30, 22, 26, 18].entries()) {
	const y = screen.y + 10 + i * 9;
	s.line(
		lineOnTop([screen.x + 6, y], [screen.x + 6 + span, y], SCREEN_Z, s.P),
		{
			tone: i === 0 ? "mid" : "faint",
		}
	);
}
s.solid(cylinder(TAP[0], TAP[1] + 14, 5, SCREEN_Z, 0.8, s.P, 24), {
	tone: "lo",
});
s.solid(cylinder(TAP[0], TAP[1], 5, SCREEN_Z, 0.8, s.P, 24), { lit: true });
s.line(ring(TAP[0], TAP[1], 7.5, SCREEN_Z, s.P, 32), { tone: "mid" });
// Stylus, its holder, and the arm reaching out from the column.
s.solid(cylinder(TAP[0], TAP[1], 1.8, SCREEN_Z + 1, 12, s.P, 12));
s.solid(
	cylinder(TAP[0], TAP[1], 3, SCREEN_Z + 13, ARM_Z - SCREEN_Z - 13, s.P, 16)
);
s.solid(
	slabOf(
		{
			x: COLUMN[0] - 7,
			y: COLUMN[1] - 5,
			w: TAP[0] - COLUMN[0] + 14,
			d: 10,
			r: 3,
		},
		ARM_Z,
		6,
		s.P,
		4,
		0.6
	)
);
s.solid(
	slabOf(
		{ x: TAP[0] - 7, y: TAP[1] - 7, w: 14, d: 14, r: 2 },
		ARM_Z - 4,
		12,
		s.P,
		3,
		0.6
	),
	{ tone: "lo" }
);
screws(s, [[COLUMN[0], COLUMN[1]]], ARM_Z + 6, 1.6);
// Controller box at the front right.
const box = { x: 46, y: -6, w: 36, d: 44, r: 3 };
s.halo(box, 0);
s.solid(slabOf(box, 0, 14, s.P, 4, 0.6));
knob(s, [58, 6], 14, 5, 5);
lamp(s, [72, 4], 14, { radius: 1.8 });
lamp(s, [72, 12], 14, { radius: 1.8 });
lamp(s, [72, 20], 14, { radius: 1.8 });

export const drawing = cardDrawing(s);
