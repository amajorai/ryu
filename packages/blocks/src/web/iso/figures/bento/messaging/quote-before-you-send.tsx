import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	radialTicks,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Quote before you send: a postal scale. The message (the lit parcel) sits
 * on the pan and the dial reads its cost before anything is posted; the
 * stack of credit coins beside it is what stays available.
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const BODY = { x: -78, y: -42, w: 104, d: 84, r: 6 };
const BODY_H = 14;
const PAN: [number, number] = [-44, -12];
const PAN_Z = 24;
const DIAL: [number, number] = [4, 20];
const DIAL_R = 15;
const COINS: [number, number] = [58, 4];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-44, -12, 46]]);

benchPlate(s, PLATE);
s.halo(BODY, 0);
s.solid(slabOf(BODY, 0, BODY_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BODY, 5), BODY_H, s.P, 4), { tone: "faint" });
s.line(faceRect(s, "y", BODY.y + BODY.d, BODY.x + 10, BODY.x + 40, 4, 9), {
	tone: "lo",
});
// Pan on its post, the parcel on the pan.
s.solid(cylinder(PAN[0], PAN[1], 8, BODY_H, 2, s.P, 24), { tone: "lo" });
s.solid(cylinder(PAN[0], PAN[1], 4, BODY_H + 2, PAN_Z - BODY_H - 2, s.P, 20));
s.solid(cylinder(PAN[0], PAN[1], 28, PAN_Z, 3, s.P, 48, 0.8));
s.line(ring(PAN[0], PAN[1], 24, PAN_Z + 3, s.P, 48), { tone: "faint" });
const parcel = { x: PAN[0] - 15, y: PAN[1] - 12, w: 30, d: 24, r: 2 };
s.halo(parcel, PAN_Z + 3);
s.solid(slabOf(parcel, PAN_Z + 3, 15, s.P, 4, 0.6), { lit: true });
// The dial, face up at the front of the body.
s.solid(cylinder(DIAL[0], DIAL[1], DIAL_R + 2, BODY_H, 2, s.P, 40), {
	tone: "lo",
});
const face = BODY_H + 2;
const ticks = radialTicks(
	DIAL[0],
	DIAL[1],
	DIAL_R - 1,
	24,
	4,
	face,
	[2.5, 5],
	s.P,
	-Math.PI * 0.75,
	Math.PI * 1.5
);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
s.line(lineOnTop(DIAL, [DIAL[0] + 9, DIAL[1] - 7], face + 1, s.P), {
	tone: "hi",
});
s.solid(cylinder(DIAL[0], DIAL[1], 2.5, face, 2, s.P, 16), { tone: "lo" });
screws(
	s,
	[
		[BODY.x + 8, BODY.y + BODY.d - 8],
		[BODY.x + BODY.w - 8, BODY.y + 8],
	],
	BODY_H,
	1.4
);
// Credits still available: a short stack of coins.
s.halo({ x: COINS[0] - 14, y: COINS[1] - 14, w: 28, d: 28, r: 14 }, 0);
for (let i = 0; i < 5; i++) {
	s.solid(cylinder(COINS[0], COINS[1], 13, i * 3.4, 3.4, s.P, 40, 0.4), {
		tone: i === 4 ? "hi" : "mid",
	});
}
s.line(ring(COINS[0], COINS[1], 9, 17, s.P, 36), { tone: "lo" });

export const drawing = cardDrawing(s);
