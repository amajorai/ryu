import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Approval rules: a hold press. A risky tool call (the block) sits in a
 * recessed tray, pinned under a clamp bar that is screwed down. Nothing
 * frees it but the big release button on the console beside it (the lit
 * cap), which is yours to press.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const TRAY = { x: -80, y: -30, w: 80, d: 56, r: 4 };
const TRAY_H = 8;
const CONSOLE = { x: 18, y: -34, w: 62, d: 62, r: 5 };
const CONSOLE_H = 14;
const BTN: [number, number] = [49, -3];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-40, -30, 42],
	[BTN[0], BTN[1], CONSOLE_H + 20],
]);

benchPlate(s, PLATE);
// Holding tray with a well, and the call block resting in it.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 6, 0.8));
const well = insetPlan(TRAY, 7);
s.line(planOutline(well, TRAY_H, s.P, 3), { tone: "mid" });
// Back clamp post.
const post = (y: number) => {
	s.solid(cylinder(-40, y, 4, TRAY_H, 26, s.P, 20));
	s.solid(cylinder(-40, y, 5.5, TRAY_H + 26, 3, s.P, 20), { tone: "lo" });
};
post(-26);
const call = { x: -56, y: -14, w: 32, d: 26, r: 3 };
s.halo(call, TRAY_H);
s.solid(slabOf(call, TRAY_H - 2, 16, s.P, 4, 0.8));
s.line(planOutline(insetPlan(call, 4), TRAY_H + 14, s.P, 3), { tone: "faint" });
// Clamp bar across the block, pressing on its top.
s.solid(
	slabOf({ x: -45, y: -30, w: 10, d: 56, r: 2 }, TRAY_H + 14, 5, s.P, 3, 0.6),
	{ tone: "lo" }
);
post(22);
// Screw-down knob on the bar.
s.solid(cylinder(-40, -1, 2, TRAY_H + 19, 6, s.P, 16));
s.solid(cylinder(-40, -1, 6, TRAY_H + 25, 5, s.P, 28));
s.line(knurl(-40, -1, 6, TRAY_H + 25, TRAY_H + 30, 24, s.P), { tone: "lo" });
screws(
	s,
	[
		[TRAY.x + 5, TRAY.y + TRAY.d - 5],
		[TRAY.x + TRAY.w - 5, TRAY.y + 5],
	],
	TRAY_H,
	1.2
);
// The approval console: guard ring, big release button, key switch.
s.halo(CONSOLE, 0);
s.solid(slabOf(CONSOLE, 0, CONSOLE_H, s.P, 6, 1));
s.line(planOutline(insetPlan(CONSOLE, 4), CONSOLE_H, s.P, 4), {
	tone: "faint",
});
s.solid(cylinder(BTN[0], BTN[1], 18, CONSOLE_H, 3, s.P, 40), { tone: "lo" });
s.line(ring(BTN[0], BTN[1], 15, CONSOLE_H + 3, s.P, 40), { tone: "faint" });
s.solid(cylinder(BTN[0], BTN[1], 8, CONSOLE_H + 3, 6, s.P, 32));
s.solid(cylinder(BTN[0], BTN[1], 12, CONSOLE_H + 9, 5, s.P, 40, 1), {
	lit: true,
});
lamp(s, [CONSOLE.x + 8, CONSOLE.y + 8], CONSOLE_H, { radius: 1.8 });
knob(
	s,
	[CONSOLE.x + CONSOLE.w - 10, CONSOLE.y + CONSOLE.d - 10],
	CONSOLE_H,
	3.4,
	4
);
screws(
	s,
	[
		[CONSOLE.x + 8, CONSOLE.y + CONSOLE.d - 8],
		[CONSOLE.x + CONSOLE.w - 8, CONSOLE.y + 8],
	],
	CONSOLE_H,
	1.2
);

export const drawing = cardDrawing(s);
