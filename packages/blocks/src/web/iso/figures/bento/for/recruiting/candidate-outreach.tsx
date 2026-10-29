import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Candidate outreach: a mailbox on its post with the flag raised (the lit
 * part): a drafted message is in and waiting to go. The tray in front holds
 * the follow-ups, already addressed and stacked in order.
 */

const PLATE = { x: -92, y: -52, w: 184, d: 104, r: 8 };
const POST = { x: -34, y: -6, w: 12, d: 12, r: 1.5 };
const POST_H = 30;
const BOX = { x: -60, y: -16, w: 64, d: 32, r: 6 };
const BOX_H = 24;
const TRAY = { x: 24, y: -10, w: 52, d: 42, r: 3 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-10, 16, POST_H + BOX_H + 26],
]);

benchPlate(s, PLATE);
// Post on a round foot.
s.halo({ x: -42, y: -14, w: 28, d: 28, r: 14 }, 0);
s.solid(cylinder(-28, 0, 14, 0, 3, s.P, 36, 0.6), { tone: "lo" });
s.solid(slabOf(POST, 3, POST_H - 3, s.P, 3, 0.4));
// The box, its door on the near end.
s.solid(slabOf(BOX, POST_H, BOX_H, s.P, 8, 1.2));
s.line(planOutline(insetPlan(BOX, 4), POST_H + BOX_H, s.P, 6), {
	tone: "faint",
});
s.line(
	faceRect(
		s,
		"x",
		BOX.x + BOX.w,
		BOX.y + 5,
		BOX.y + BOX.d - 5,
		POST_H + 4,
		POST_H + BOX_H - 4
	),
	{
		tone: "lo",
	}
);
// Flag on the near side, pivot then raised arm.
const flagY = BOX.y + BOX.d;
s.solid(
	slabOf({ x: -16, y: flagY, w: 6, d: 2, r: 0.5 }, POST_H + 8, 6, s.P, 2),
	{
		tone: "lo",
	}
);
s.solid(
	slabOf(
		{ x: -14.5, y: flagY + 2, w: 3, d: 2, r: 0.5 },
		POST_H + 10,
		34,
		s.P,
		2
	)
);
s.solid(
	slabOf(
		{ x: -14.5, y: flagY + 2, w: 16, d: 2, r: 0.5 },
		POST_H + 34,
		10,
		s.P,
		2
	),
	{ lit: true }
);
// Follow-ups waiting in the tray.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 5, s.P, 4, 0.6), { tone: "lo" });
const env = insetPlan(TRAY, 5);
for (let i = 0; i < 4; i++) {
	const z = 5 + i * 2.2;
	const plan = { ...env, x: env.x + i * 1.5, y: env.y - i * 1.5 };
	s.solid(slabOf(plan, z, 1.6, s.P, 2), { crease: "none" });
	if (i === 3) {
		const top = z + 1.6;
		const midX = plan.x + plan.w / 2;
		s.line(
			lineOnTop(
				[plan.x + 1, plan.y + 1],
				[midX, plan.y + plan.d / 2],
				top,
				s.P
			),
			{
				tone: "mid",
			}
		);
		s.line(
			lineOnTop(
				[midX, plan.y + plan.d / 2],
				[plan.x + plan.w - 1, plan.y + 1],
				top,
				s.P
			),
			{ tone: "mid" }
		);
	}
}

export const drawing = cardDrawing(s);
