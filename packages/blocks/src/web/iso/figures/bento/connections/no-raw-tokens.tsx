import {
	boxCorners,
	circleRing,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRules, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * No raw tokens: the tokens sit in a sealed, bolted canister with no slot
 * to reach in. Agents only get the button console in front: each button is
 * one named action, and pressing it (the lit button) runs that action
 * through the conduit without the token ever leaving the canister.
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const CAN: [number, number] = [-50, -10];
const CAN_R = 26;
const CAN_H = 46;
const CONSOLE = { x: -6, y: -14, w: 92, d: 46, r: 5 };
const CONSOLE_H = 14;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CAN[0], CAN[1], CAN_H + 8],
]);

benchPlate(s, PLATE);
// Sealed canister: collar, body, bolted lid, centre boss.
s.halo({ x: CAN[0] - 30, y: CAN[1] - 30, w: 60, d: 60, r: 30 }, 0);
s.solid(cylinder(CAN[0], CAN[1], CAN_R + 3, 0, 4, s.P, 48, 0.6), {
	tone: "lo",
});
s.solid(cylinder(CAN[0], CAN[1], CAN_R, 4, CAN_H - 8, s.P, 48));
s.line(ring(CAN[0], CAN[1], CAN_R, 20, s.P, 48), { tone: "faint" });
s.solid(cylinder(CAN[0], CAN[1], CAN_R + 2, CAN_H - 4, 4, s.P, 48, 0.6));
screws(s, circleRing(CAN[0], CAN[1], CAN_R - 4, 8), CAN_H, 1.4);
s.solid(cylinder(CAN[0], CAN[1], 9, CAN_H, 4, s.P, 32), { tone: "lo" });
s.line(knurl(CAN[0], CAN[1], 9, CAN_H, CAN_H + 4, 28, s.P), { tone: "lo" });
// Conduit from the canister to the console.
s.solid(
	slabOf(
		{ x: CAN[0] + CAN_R - 4, y: -6, w: 26, d: 10, r: 2 },
		0,
		7,
		s.P,
		3,
		0.4
	),
	{
		tone: "lo",
	}
);
// Action console: a row of named buttons.
s.halo(CONSOLE, 0);
s.solid(slabOf(CONSOLE, 0, CONSOLE_H, s.P, 6, 1));
s.line(planOutline(insetPlan(CONSOLE, 4), CONSOLE_H, s.P, 4), {
	tone: "faint",
});
lamp(s, [CONSOLE.x + CONSOLE.w - 10, CONSOLE.y + 9], CONSOLE_H, {
	radius: 1.6,
});
const front = CONSOLE.y + CONSOLE.d;
for (let i = 0; i < 4; i++) {
	const x = CONSOLE.x + 14 + i * 21;
	const lit = i === 2;
	s.solid(
		slabOf(
			{ x: x - 8, y: front - 22, w: 16, d: 16, r: 2 },
			CONSOLE_H,
			1.4,
			s.P,
			3
		),
		{
			tone: "lo",
		}
	);
	s.solid(
		cylinder(x, front - 14, 5.5, CONSOLE_H + 1.4, lit ? 1.6 : 4, s.P, 28, 0.6),
		{
			lit,
		}
	);
	faceRules(s, "y", front, x - 7, 7, [14], 4);
}

export const drawing = cardDrawing(s);
