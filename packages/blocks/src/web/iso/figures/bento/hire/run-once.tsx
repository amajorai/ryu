import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	knob,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Run once: a sealed one-shot machine. The approved access goes in as a
 * single pass card standing in the slot on top; the lever has been pulled
 * down once, and the result has dropped into the delivery tray in front (the lit
 * block). There is no second slot and no second pull.
 */

const PLATE = { x: -84, y: -50, w: 124, d: 104, r: 8 };
const BODY = { x: -66, y: -36, w: 76, d: 56, r: 5 };
const BODY_H = 36;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-30, -20, 64]]);

benchPlate(s, PLATE);
s.halo(BODY, 0);
s.solid(slabOf(BODY, 0, BODY_H, s.P, 8, 1.2));
s.line(planOutline(insetPlan(BODY, 5), BODY_H, s.P, 6), { tone: "faint" });
screws(
	s,
	[
		[BODY.x + 9, BODY.y + BODY.d - 9],
		[BODY.x + BODY.w - 9, BODY.y + 9],
	],
	BODY_H,
	1.6
);
// The pass card in its slot on the top face.
const slot = { x: -38, y: -24, w: 24, d: 5, r: 1 };
s.line(planOutline(slot, BODY_H, s.P, 2), { tone: "mid" });
s.solid(slabOf({ x: -36, y: -23, w: 20, d: 3, r: 0.6 }, BODY_H, 22, s.P, 2), {
	crease: "none",
});
// Status lamps (idle) and a setting knob on top.
lamp(s, [-50, 8], BODY_H, { radius: 1.8 });
lamp(s, [-42, 8], BODY_H, { radius: 1.8 });
knob(s, [-10, -2], BODY_H, 6, 5);
// The lever on the right side, pulled down to the foot of its slot.
const side = BODY.x + BODY.w;
s.line(faceRect(s, "x", side, -22, -14, 8, 30), { tone: "mid" });
s.solid(slabOf({ x: side, y: -20, w: 8, d: 4, r: 1 }, 9, 3, s.P, 2));
s.solid(cylinder(side + 9, -18, 3.5, 6, 10, s.P, 24, 1), { tone: "lo" });
// Delivery chute on the front face and the tray holding the result.
const front = BODY.y + BODY.d;
s.line(faceRect(s, "y", front, BODY.x + 18, BODY.x + 58, 6, 20), {
	tone: "lo",
});
const tray = { x: BODY.x + 12, y: front, w: 52, d: 22, r: 3 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 5, s.P, 4, 0.6), { tone: "lo" });
s.solid(
	slabOf({ x: BODY.x + 26, y: front + 5, w: 24, d: 12, r: 2 }, 5, 8, s.P, 3),
	{
		lit: true,
	}
);

export const drawing = cardDrawing(s);
