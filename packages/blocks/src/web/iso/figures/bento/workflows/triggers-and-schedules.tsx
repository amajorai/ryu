import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	lineOnTop,
	planOutline,
	radialTicks,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, jack, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Triggers and schedules: a starter console with four ways in. A timer dial
 * (the schedule), a cable plugged into a jack (the webhook), a toggle lever
 * (the app event), and a big mushroom push button (start it by hand, the lit
 * cap). Any one of them closes the same start circuit.
 */

const PLATE = { x: -96, y: -58, w: 192, d: 116, r: 8 };
const BOX = { x: -78, y: -42, w: 132, d: 76, r: 6 };
const H = 14;
const DIAL: [number, number] = [-44, -14];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-44, -14, 26],
	[0, -26, 30],
	[58, -21, 27],
]);

benchPlate(s, PLATE);
// The console.
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, H, s.P, 8, 1.2));
s.line(planOutline(insetPlan(BOX, 5), H, s.P, 6), { tone: "faint" });
screws(
	s,
	[
		[BOX.x + 8, BOX.y + 8],
		[BOX.x + BOX.w - 8, BOX.y + BOX.d - 8],
		[BOX.x + BOX.w - 8, BOX.y + 8],
		[BOX.x + 8, BOX.y + BOX.d - 8],
	],
	H,
	1.4
);
// Timer dial: a raised drum with an hour ring and a hand.
s.solid(cylinder(DIAL[0], DIAL[1], 22, H, 4, s.P, 48, 0.6), { tone: "lo" });
s.solid(cylinder(DIAL[0], DIAL[1], 19, H + 4, 3, s.P, 48));
const ticks = radialTicks(DIAL[0], DIAL[1], 17, 24, 6, H + 7, [2, 4], s.P);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
s.line(lineOnTop(DIAL, [DIAL[0] + 9, DIAL[1] - 8], H + 7, s.P), {
	tone: "hi",
});
s.solid(cylinder(DIAL[0], DIAL[1], 2.6, H + 7, 2, s.P, 20), { tone: "lo" });
// Drawn after the console (it is nearer): a small terminal block on the plate where the webhook cable comes in.
const terminal = { x: 62, y: -30, w: 22, d: 20, r: 2 };
s.halo(terminal, 0);
s.solid(slabOf(terminal, 0, 10, s.P, 4, 0.6), { tone: "lo" });
s.line(ring(73, -20, 2.4, 10, s.P, 16), { tone: "mid" });
// Webhook: a jack with a plug and a cable back to the terminal.
jack(s, [38, -22], H);
s.solid(cylinder(38, -22, 3, H, 8, s.P, 24), { tone: "lo" });
s.wire([38, -22, H + 8], [73, -20, 10], [[58, -21, H + 12]], { tone: "mid" });
// Toggle lever for app events.
const toggle = { x: -8, y: -32, w: 16, d: 12, r: 2 };
s.solid(slabOf(toggle, H, 3, s.P, 3), { tone: "lo" });
s.solid(cylinder(0, -26, 1.4, H + 3, 10, s.P, 12));
s.solid(cylinder(0, -26, 2.4, H + 13, 2, s.P, 16));
// Status lamps along the front edge.
for (const x of [-60, -50, -40]) {
	lamp(s, [x, 22], H, { radius: 1.6 });
}
// Mushroom push button: start by hand.
s.solid(cylinder(18, 12, 12, H, 3, s.P, 40), { tone: "lo" });
s.line(knurl(18, 12, 12, H, H + 3, 36, s.P), { tone: "lo" });
s.solid(cylinder(18, 12, 6, H + 3, 4, s.P, 28));
s.solid(cylinder(18, 12, 10, H + 7, 4, s.P, 40, 0.8), { lit: true });

export const drawing = cardDrawing(s);
