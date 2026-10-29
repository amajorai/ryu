import {
	boxCorners,
	cylinder,
	pathOf,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Lifecycle and onboarding emails: a sequence rack and a post box. The
 * envelopes stand in their slots in send order; the first one is already
 * going into the post box's slot (the lit envelope), queued to go out.
 */

const PLATE = { x: -92, y: -48, w: 184, d: 96, r: 8 };
const RACK = { x: -84, y: -18, w: 100, d: 26, r: 3 };
const RACK_H = 6;
const SLOT_Y = RACK.y + 12;
const BOX = { x: 30, y: -28, w: 48, d: 34, r: 5 };
const POST_H = 20;
const BOX_TOP = POST_H + 30;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[52, -14, BOX_TOP + 16],
]);

/** An envelope standing upright with its face toward +y. */
function envelope(x: number, z: number, height: number, lit = false) {
	const plan = { x, y: SLOT_Y, w: 20, d: 3, r: 0.6 };
	s.solid(slabOf(plan, z, height, s.P, 2, 0.2), { lit });
	const face = plan.y + plan.d;
	const top = z + height;
	s.line(
		pathOf([
			s.at([x + 1, face, top - 1]),
			s.at([x + 10, face, top - 7]),
			s.at([x + 19, face, top - 1]),
		]),
		{ tone: lit ? "mid" : "lo" }
	);
}

benchPlate(s, PLATE);
// The sequence rack: one slot per step, in send order.
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 4, 0.6));
screws(
	s,
	[
		[RACK.x + 5, RACK.y + 5],
		[RACK.x + RACK.w - 5, RACK.y + RACK.d - 5],
	],
	RACK_H,
	1.3
);
for (const x of [-78, -54, -30, -6]) {
	s.line(planOutline({ x, y: SLOT_Y - 1, w: 22, d: 5, r: 1 }, RACK_H, s.P, 2), {
		tone: "lo",
	});
}
envelope(-77, RACK_H, 26);
envelope(-53, RACK_H, 26);
envelope(-29, RACK_H, 26);
// Post box on its post.
s.halo({ x: 48, y: -16, w: 12, d: 12, r: 6 }, 0);
s.solid(cylinder(54, -10, 8, 0, 2, s.P, 28), { tone: "lo" });
s.solid(cylinder(54, -10, 3.4, 2, POST_H - 2, s.P, 20));
s.solid(slabOf(BOX, POST_H, BOX_TOP - POST_H, s.P, 6, 1));
s.line(
	faceRect(
		s,
		"y",
		BOX.y + BOX.d,
		BOX.x + 8,
		BOX.x + BOX.w - 8,
		POST_H + 8,
		POST_H + 20
	),
	{
		tone: "lo",
	}
);
// The slot on top with the next envelope going in.
const slot = { x: BOX.x + 13, y: -14, w: 22, d: 5, r: 1 };
s.line(planOutline(slot, BOX_TOP, s.P, 2), { tone: "mid" });
const sending = { x: BOX.x + 14, y: -13, w: 20, d: 3, r: 0.6 };
s.solid(slabOf(sending, BOX_TOP, 14, s.P, 2, 0.2), { lit: true });
// Flag on the box's side, raised.
const flag = { x: BOX.x + BOX.w, y: -20, w: 2, d: 4, r: 0.4 };
s.solid(slabOf(flag, POST_H + 10, 28, s.P, 2));
s.solid(
	slabOf(
		{ x: BOX.x + BOX.w, y: -20, w: 2, d: 14, r: 0.4 },
		POST_H + 28,
		10,
		s.P,
		2
	),
	{
		tone: "lo",
	}
);

export const drawing = cardDrawing(s);
