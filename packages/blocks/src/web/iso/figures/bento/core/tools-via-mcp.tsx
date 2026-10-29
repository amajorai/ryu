import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, byDepth, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Tools via MCP: a bit organiser. Each agent gets only the bits you seat in
 * its tray (two sockets stay empty). The long shell bit (the lit part) is
 * the one an agent may reach for; the gantry at the end of the tray scans
 * every bit that leaves it.
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const TRAY = { x: -78, y: -34, w: 140, d: 60, r: 5 };
const TRAY_H = 12;
const GANTRY_X = 48;
const BAR_Z = 42;

type Bit = [number, number, number, boolean];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[GANTRY_X, 0, BAR_Z + 8],
]);

const bits: Bit[] = [];
const heights = [16, 12, 0, 18, 14, 12, 18, 14, 0, 16];
for (let i = 0; i < 10; i++) {
	const column = i % 5;
	const row = Math.floor(i / 5);
	bits.push([-64 + column * 24, -18 + row * 28, heights[i] ?? 0, false]);
}

function post(y: number) {
	const plan = { x: GANTRY_X - 5, y: y - 5, w: 10, d: 10, r: 2 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, BAR_Z, s.P, 4, 0.6));
}

benchPlate(s, PLATE);
post(-44);
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 6, 1));
s.line(planOutline(insetPlan(TRAY, 4), TRAY_H, s.P, 4), { tone: "faint" });
for (const [x, y, height] of byDepth(bits, s, TRAY_H)) {
	s.line(ring(x, y, 6.5, TRAY_H, s.P, 28), { tone: "lo" });
	if (height === 0) {
		s.line(ring(x, y, 4.5, TRAY_H, s.P, 24), { tone: "faint" });
		continue;
	}
	const lit = x === -16 && y === 10;
	const tall = lit ? height + 10 : height;
	s.solid(cylinder(x, y, 4.5, TRAY_H, tall - 4, s.P, 6, 0.4), { lit });
	s.solid(cylinder(x, y, 2, TRAY_H + tall - 4, 4, s.P, 16), {
		tone: lit ? "hi" : "lo",
		lit,
	});
}
post(36);
// The crossbar spans the tray along y with a lamp over the scan line.
s.solid(
	slabOf({ x: GANTRY_X - 7, y: -48, w: 14, d: 88, r: 2 }, BAR_Z, 6, s.P, 4, 0.6)
);
lamp(s, [GANTRY_X, 10], BAR_Z + 6, { radius: 1.8 });
screws(
	s,
	[
		[GANTRY_X, -40],
		[GANTRY_X, 32],
	],
	BAR_Z + 6,
	1.4
);

export const drawing = cardDrawing(s);
