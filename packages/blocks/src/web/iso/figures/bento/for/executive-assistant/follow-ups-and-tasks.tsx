import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Follow-ups and tasks: a rack of addressed envelopes standing in order,
 * each one an action item with its owner, beside a mailbox. The mailbox flag
 * is up (the lit part): the follow-ups are queued, waiting for you to send.
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const RACK = { x: -86, y: -30, w: 76, d: 46, r: 3 };
const RACK_H = 6;
const POST = { x: 36, y: -12, w: 10, d: 10, r: 1 };
const BOX = { x: 14, y: -24, w: 58, d: 34, r: 8 };
const BOX_Z = 22;
const BOX_H = 26;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[64, 10, BOX_Z + BOX_H + 22],
]);

benchPlate(s, PLATE);
// Envelope rack: a tray with five letters standing in its slots.
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 4, 0.6));
s.line(planOutline(insetPlan(RACK, 3), RACK_H, s.P, 2), { tone: "faint" });
for (let i = 0; i < 5; i++) {
	const env = {
		x: RACK.x + 8 + i * 14,
		y: RACK.y + 6,
		w: 3,
		d: RACK.d - 12,
		r: 0.4,
	};
	s.solid(slabOf(env, RACK_H, 24 - i * 2, s.P, 2), { crease: "none" });
}
knob(s, [RACK.x + 10, RACK.y + RACK.d + 8], 0, 4, 5);
// Mailbox on its post, slot on the near face, flag raised on the side.
s.halo({ x: 30, y: -18, w: 22, d: 22, r: 4 }, 0);
s.solid(slabOf({ x: 31, y: -17, w: 20, d: 20, r: 2 }, 0, 3, s.P, 3), {
	tone: "lo",
});
s.solid(slabOf(POST, 3, BOX_Z - 3, s.P, 2));
s.solid(slabOf(BOX, BOX_Z, BOX_H, s.P, 8, 1.2));
s.line(planOutline(insetPlan(BOX, 5), BOX_Z + BOX_H, s.P, 6), {
	tone: "faint",
});
const front = BOX.y + BOX.d;
s.line(
	faceRect(
		s,
		"y",
		front,
		BOX.x + 14,
		BOX.x + BOX.w - 18,
		BOX_Z + 15,
		BOX_Z + 18
	),
	{
		tone: "mid",
	}
);
s.line(
	faceRect(
		s,
		"x",
		BOX.x + BOX.w,
		BOX.y + 8,
		BOX.y + BOX.d - 8,
		BOX_Z + 4,
		BOX_Z + BOX_H - 4
	),
	{
		tone: "faint",
	}
);
const poleX = BOX.x + BOX.w - 10;
s.solid(
	slabOf(
		{ x: poleX, y: front, w: 3, d: 3, r: 0.6 },
		BOX_Z + 6,
		BOX_H + 14,
		s.P,
		2
	),
	{
		tone: "lo",
	}
);
s.solid(
	slabOf(
		{ x: poleX - 14, y: front, w: 14, d: 2.4, r: 0.6 },
		BOX_Z + BOX_H + 10,
		10,
		s.P,
		2
	),
	{
		lit: true,
	}
);
screws(s, [[80, 32]], 0, 1.4);

export const drawing = cardDrawing(s);
