import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRules, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Sandboxed plugin code: the plugin (the lit block) sits inside a closed cage
 * frame on its own tray. Outside the cage, the terminal strip's three sockets
 * (files, network, environment) are capped: nothing is wired in to start.
 */

const PLATE = { x: -96, y: -52, w: 192, d: 104, r: 8 };
const TRAY = { x: -84, y: -42, w: 104, d: 84, r: 5 };
const CAGE = insetPlan(TRAY, 6);
const POST_R = 2.6;
const CAGE_H = 42;
const BLOCK = { x: -58, y: -22, w: 50, d: 44, r: 4 };
const STRIP = { x: 44, y: -30, w: 26, d: 62, r: 4 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CAGE.x, CAGE.y, CAGE_H + 4],
]);

const x0 = CAGE.x + POST_R;
const x1 = CAGE.x + CAGE.w - POST_R;
const y0 = CAGE.y + POST_R;
const y1 = CAGE.y + CAGE.d - POST_R;
const post = (x: number, y: number) =>
	s.solid(cylinder(x, y, POST_R, 6, CAGE_H - 6, s.P, 16));
const railX = (y: number) =>
	s.solid(
		slabOf(
			{ x: CAGE.x, y: y - POST_R, w: CAGE.w, d: POST_R * 2, r: 1 },
			CAGE_H,
			4,
			s.P,
			2
		)
	);
const railY = (x: number) =>
	s.solid(
		slabOf(
			{ x: x - POST_R, y: CAGE.y, w: POST_R * 2, d: CAGE.d, r: 1 },
			CAGE_H,
			4,
			s.P,
			2
		)
	);

benchPlate(s, PLATE);
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 6, s.P, 6, 0.8), { tone: "lo" });
// Back of the cage.
post(x0, y0);
railX(y0);
railY(x0);
post(x1, y0);
post(x0, y1);
// The plugin inside, a module with one socket and a label strip.
s.halo(BLOCK, 6);
s.solid(slabOf(BLOCK, 6, 20, s.P, 4, 0.8), { lit: true });
s.line(planOutline(insetPlan(BLOCK, 4), 26, s.P, 3), { tone: "lo" });
s.line(ring(BLOCK.x + 14, BLOCK.y + 14, 4, 26, s.P, 20), { tone: "mid" });
faceRules(s, "y", BLOCK.y + BLOCK.d, BLOCK.x + 8, 20, [28, 18], 5);
// Front of the cage.
post(x1, y1);
railY(x1);
railX(y1);
// Terminal strip outside: three sockets, each capped.
s.halo(STRIP, 0);
s.solid(slabOf(STRIP, 0, 8, s.P, 5, 0.8));
screws(
	s,
	[
		[STRIP.x + STRIP.w / 2, STRIP.y + 6],
		[STRIP.x + STRIP.w / 2, STRIP.y + STRIP.d - 6],
	],
	8,
	1.4
);
for (const y of [STRIP.y + 18, STRIP.y + 31, STRIP.y + 44]) {
	const x = STRIP.x + STRIP.w / 2;
	s.solid(cylinder(x, y, 5.6, 8, 1, s.P, 24));
	s.solid(cylinder(x, y, 4.4, 9, 3, s.P, 24, 0.4), { tone: "lo" });
	s.line(ring(x, y, 1.6, 12, s.P, 16), { tone: "mid" });
}

export const drawing = cardDrawing(s);
