import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	ring,
	sideArc,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Encrypted secrets: a sealed, banded canister holds the secrets; it only
 * opens with the key that lives apart from it, on the keychain stand beside
 * it (the lit key, lying on its ring).
 */

const PLATE = { x: -92, y: -50, w: 184, d: 100, r: 8 };
const CAN: [number, number] = [-34, -4];
const CAN_R = 30;
const CAN_H = 40;
const STAND = { x: 14, y: -22, w: 68, d: 50, r: 5 };
const STAND_H = 10;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners(
		{ x: CAN[0] - CAN_R, y: CAN[1] - CAN_R, w: CAN_R * 2, d: CAN_R * 2, r: 0 },
		CAN_H + 7,
		CAN_H + 10
	),
]);

benchPlate(s, PLATE);
// The canister: foot ring, banded body, knurled screw lid and seal bolt.
s.halo(
	{
		x: CAN[0] - CAN_R,
		y: CAN[1] - CAN_R,
		w: CAN_R * 2,
		d: CAN_R * 2,
		r: CAN_R,
	},
	0
);
s.solid(cylinder(CAN[0], CAN[1], CAN_R + 3, 0, 4, s.P, 60, 0.6), {
	tone: "lo",
});
s.solid(cylinder(CAN[0], CAN[1], CAN_R, 4, CAN_H - 4, s.P, 60, 0.8));
for (const z of [12, 18, 30]) {
	s.line(sideArc(CAN[0], CAN[1], CAN_R, z, s.P, 36), {
		tone: z === 18 ? "lo" : "faint",
	});
}
s.solid(cylinder(CAN[0], CAN[1], CAN_R + 1.5, CAN_H, 7, s.P, 60, 0.6));
s.line(knurl(CAN[0], CAN[1], CAN_R + 1.5, CAN_H, CAN_H + 7, 48, s.P), {
	tone: "lo",
});
s.line(ring(CAN[0], CAN[1], CAN_R - 6, CAN_H + 7, s.P, 48), {
	tone: "faint",
});
s.solid(cylinder(CAN[0], CAN[1], 7, CAN_H + 7, 3, s.P, 6, 0.4), {
	tone: "lo",
});
s.line(ring(CAN[0], CAN[1], 2.4, CAN_H + 10, s.P, 16), { tone: "mid" });
// The keychain stand, apart from the canister.
s.halo(STAND, 0);
s.solid(slabOf(STAND, 0, STAND_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(STAND, 4), STAND_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[STAND.x + 7, STAND.y + 7],
		[STAND.x + STAND.w - 7, STAND.y + STAND.d - 7],
	],
	STAND_H,
	1.4
);
lamp(s, [STAND.x + STAND.w - 8, STAND.y + 8], STAND_H, { radius: 1.6 });
// The ring post and its ring, with the key lying from it.
const post: [number, number] = [STAND.x + 14, STAND.y + 20];
s.solid(cylinder(post[0], post[1], 9, STAND_H, 1.6, s.P, 36, 0.3), {
	tone: "lo",
});
s.line(ring(post[0], post[1], 6, STAND_H + 1.6, s.P, 32), { tone: "mid" });
s.solid(cylinder(post[0] + 15, post[1] + 6, 8, STAND_H, 3, s.P, 32, 0.3), {
	lit: true,
});
s.solid(
	slabOf(
		{ x: post[0] + 21, y: post[1] + 4, w: 26, d: 4, r: 0.5 },
		STAND_H,
		3,
		s.P,
		2
	),
	{ lit: true }
);
s.solid(
	slabOf(
		{ x: post[0] + 39, y: post[1] + 8, w: 4, d: 5, r: 0.4 },
		STAND_H,
		3,
		s.P,
		2
	),
	{ lit: true }
);

export const drawing = cardDrawing(s);
