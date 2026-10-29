import {
	boxCorners,
	corners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, faceRect, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Travel coordination: a packed carry-on, handle up, on four casters. The
 * whole trip goes in one case; the boarding pass is tucked in its top pocket
 * (the lit part), and the other confirmations wait in a stack beside it.
 */

const PLATE = { x: -80, y: -46, w: 160, d: 92, r: 8 };
const CASE = { x: -58, y: -22, w: 78, d: 32, r: 6 };
const WHEEL_H = 6;
const CASE_TOP = 64;
const HANDLE_X = [-38, -10];
const HANDLE_Y = -6;
const HANDLE_TOP = CASE_TOP + 14;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-24, HANDLE_Y, HANDLE_TOP + 4],
]);

benchPlate(s, PLATE);
s.halo(CASE, 0);
for (const [x, y] of byDepth(corners(CASE, 6), s)) {
	s.solid(cylinder(x, y, 3.2, 0, WHEEL_H, s.P, 20), { tone: "lo" });
}
s.solid(slabOf(CASE, WHEEL_H, CASE_TOP - WHEEL_H, s.P, 8, 1.2));
s.line(planOutline(insetPlan(CASE, 4), CASE_TOP, s.P, 6), { tone: "faint" });
// Zip seam and front pocket on the near long face.
const front = CASE.y + CASE.d;
s.line(faceRect(s, "y", front, CASE.x + 8, CASE.x + CASE.w - 8, 14, 46), {
	tone: "lo",
});
s.line(faceRect(s, "y", front, CASE.x + 14, CASE.x + CASE.w - 14, 20, 34), {
	tone: "faint",
});
s.line(
	faceRect(s, "x", CASE.x + CASE.w, CASE.y + 6, CASE.y + CASE.d - 6, 40, 44),
	{
		tone: "lo",
	}
);
// Telescoping handle.
for (const x of HANDLE_X) {
	s.solid(cylinder(x, HANDLE_Y, 3, CASE_TOP, 2, s.P, 20), { tone: "lo" });
	s.solid(
		cylinder(x, HANDLE_Y, 1.8, CASE_TOP + 2, HANDLE_TOP - CASE_TOP - 2, s.P, 16)
	);
}
s.solid(
	slabOf(
		{ x: -42, y: HANDLE_Y - 3, w: 36, d: 6, r: 3 },
		HANDLE_TOP,
		4,
		s.P,
		4,
		0.6
	)
);
// Top pocket with the boarding pass standing in it.
const pocket = { x: 2, y: -16, w: 12, d: 20, r: 2 };
s.solid(slabOf(pocket, CASE_TOP, 2, s.P, 3), { tone: "lo" });
s.solid(
	slabOf({ x: 6, y: -14, w: 3, d: 16, r: 0.6 }, CASE_TOP + 2, 12, s.P, 2),
	{
		lit: true,
	}
);
// The other confirmations, squared up beside the case.
const stack = { x: 38, y: -8, w: 30, d: 40, r: 2 };
s.halo(stack, 0);
s.solid(slabOf(stack, 0, 4, s.P, 3, 0.4), { tone: "lo" });
for (let i = 0; i < 4; i++) {
	s.solid(
		slabOf(
			{ x: stack.x + 4 + (i % 2), y: stack.y + 4 + i, w: 22, d: 30, r: 1 },
			4 + i * 1.6,
			1.6,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
lamp(s, [stack.x + 6, stack.y + stack.d - 3], 4, { radius: 1.2 });

export const drawing = cardDrawing(s);
