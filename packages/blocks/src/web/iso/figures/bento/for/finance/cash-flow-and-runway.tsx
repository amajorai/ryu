import {
	boxCorners,
	cylinder,
	knurl,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Cash flow and runway: a cash tank. Receivables run in on the high pipe at
 * the back; payables and burn drain out of the tap at the front. The float in
 * the sight tube (lit) shows the level left, and so the runway.
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const TANK: [number, number] = [-6, -8];
const TANK_R = 28;
const TANK_H = 48;
const GAUGE: [number, number] = [17, 16];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[TANK[0], TANK[1], TANK_H + 12],
]);

benchPlate(s, PLATE);
// Inlet pipe on a post at the back left, entering the tank high.
s.solid(cylinder(-78, -12, 3.4, 0, 38, s.P, 20));
s.solid(slabOf({ x: -84, y: -15, w: 60, d: 6, r: 1.5 }, 38, 6, s.P, 3));
s.solid(slabOf({ x: -86, y: -18, w: 6, d: 12, r: 1 }, 36, 10, s.P, 2), {
	tone: "lo",
});
// The tank on a ring stand, lid and hatch on top.
s.halo({ x: TANK[0] - 31, y: TANK[1] - 31, w: 62, d: 62, r: 31 }, 0);
s.solid(cylinder(TANK[0], TANK[1], TANK_R + 3, 0, 4, s.P, 48), { tone: "lo" });
s.solid(cylinder(TANK[0], TANK[1], TANK_R, 4, TANK_H - 4, s.P, 48, 0.8));
s.solid(cylinder(TANK[0], TANK[1], TANK_R + 1.5, TANK_H, 3, s.P, 48, 0.5));
s.line(ring(TANK[0], TANK[1], TANK_R - 4, TANK_H + 3, s.P, 44), {
	tone: "faint",
});
s.solid(cylinder(TANK[0] - 6, TANK[1] - 4, 8, TANK_H + 3, 3, s.P, 32), {
	tone: "lo",
});
s.solid(cylinder(TANK[0] - 6, TANK[1] - 4, 2.6, TANK_H + 6, 4, s.P, 16));
screws(
	s,
	[
		[TANK[0] + 12, TANK[1] + 12],
		[TANK[0] + 16, TANK[1] - 8],
	],
	TANK_H + 3,
	1.4
);
// Outlet: a low pipe to the right with a handwheel valve over a drip tray.
s.solid(slabOf({ x: 60, y: -18, w: 22, d: 26, r: 3 }, 0, 3, s.P, 3), {
	tone: "lo",
});
s.solid(slabOf({ x: 21, y: -11, w: 49, d: 6, r: 1.5 }, 10, 6, s.P, 3));
s.solid(slabOf({ x: 66, y: -12, w: 8, d: 8, r: 1 }, 6, 12, s.P, 2), {
	tone: "lo",
});
s.solid(cylinder(46, -8, 2, 16, 6, s.P, 16));
s.solid(cylinder(46, -8, 9, 22, 2.4, s.P, 32, 0.4));
s.line(knurl(46, -8, 9, 22, 24.4, 28, s.P), { tone: "lo" });
// Sight tube piped to the tank wall low and high, the float riding at the level.
for (const z of [10, 36]) {
	s.solid(slabOf({ x: 12, y: 11, w: 4, d: 4, r: 1 }, z, 4, s.P, 2), {
		tone: "lo",
	});
}
s.solid(cylinder(GAUGE[0], GAUGE[1], 5, 0, 5, s.P, 20), { tone: "lo" });
s.solid(cylinder(GAUGE[0], GAUGE[1], 3.6, 5, 15, s.P, 20), { tone: "lo" });
s.solid(cylinder(GAUGE[0], GAUGE[1], 4.6, 20, 5, s.P, 20), { lit: true });
s.solid(cylinder(GAUGE[0], GAUGE[1], 3.6, 25, 17, s.P, 20), { tone: "faint" });
s.solid(cylinder(GAUGE[0], GAUGE[1], 5, 42, 3, s.P, 20));

export const drawing = cardDrawing(s);
