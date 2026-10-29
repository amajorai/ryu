import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * MCP or REST: one tool press fed by two different hoppers, a round one and
 * a square one. Whichever way an order goes in, the same part comes out on
 * the tray in front (the lit part).
 */

const PLATE = { x: -92, y: -56, w: 184, d: 112, r: 8 };
const BODY = { x: -56, y: -40, w: 92, d: 52, r: 4 };
const BODY_H = 30;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-10, -20, 70]]);

benchPlate(s, PLATE);
s.halo(BODY, 0);
s.solid(slabOf(BODY, 0, BODY_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BODY, 4), BODY_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[BODY.x + 7, BODY.y + 7],
		[BODY.x + BODY.w - 7, BODY.y + BODY.d - 7],
	],
	BODY_H,
	1.4
);
// Round hopper (MCP): a collar and a stepped funnel.
const RX = -28;
const RY = -16;
s.solid(cylinder(RX, RY, 10, BODY_H, 4, s.P, 36), { tone: "lo" });
s.solid(cylinder(RX, RY, 14, BODY_H + 4, 10, s.P, 40, 0.6));
s.solid(cylinder(RX, RY, 19, BODY_H + 14, 8, s.P, 44, 0.6));
s.line(ring(RX, RY, 15, BODY_H + 22, s.P, 44), { tone: "lo" });
// Square hopper (REST): the same steps, square.
const QX = 14;
const QY = -14;
const square = (half: number) => ({
	x: QX - half,
	y: QY - half,
	w: half * 2,
	d: half * 2,
	r: 1.5,
});
s.solid(slabOf(square(9), BODY_H, 4, s.P, 2), { tone: "lo" });
s.solid(slabOf(square(13), BODY_H + 4, 10, s.P, 2, 0.6));
s.solid(slabOf(square(17), BODY_H + 14, 8, s.P, 2, 0.6));
s.line(planOutline(square(13.5), BODY_H + 22, s.P, 2), { tone: "lo" });
// Output mouth on the front face and the tray it drops into.
const front = BODY.y + BODY.d;
s.line(faceRect(s, "y", front, -22, 2, 6, 18), { tone: "mid" });
const tray = { x: -32, y: front, w: 44, d: 30, r: 3 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 5, s.P, 4, 0.6), { tone: "lo" });
s.line(planOutline(insetPlan(tray, 3), 5, s.P, 3), { tone: "faint" });
s.solid(slabOf({ x: -18, y: front + 8, w: 16, d: 14, r: 2 }, 5, 7, s.P, 3), {
	lit: true,
});

export const drawing = cardDrawing(s);
