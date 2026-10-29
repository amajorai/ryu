import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceLine,
	faceRect,
	faceRules,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Shared skills folder: one standard reservoir with a filler funnel on top and
 * a row of taps on its front. An install pours in through the funnel (lit),
 * and every agent draws from the same tank through its own tap and cup.
 */

const PLATE = { x: -78, y: -54, w: 156, d: 108, r: 8 };
const TANK = { x: -52, y: -38, w: 104, d: 46, r: 8 };
const FEET = 5;
const TANK_H = 40;
const TOP = FEET + TANK_H;
const FRONT = TANK.y + TANK.d;
const TAPS = [-30, 0, 30];
const FILLER: [number, number] = [-6, -16];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners(TANK, 0, TOP),
	[FILLER[0], FILLER[1], TOP + 14],
]);

benchPlate(s, PLATE);
s.halo(TANK, 0);
// Drip tray along the front, with its grate bars.
const TRAY = { x: -48, y: FRONT + 1, w: 96, d: 22, r: 3 };
s.solid(slabOf(TRAY, 0, 4, s.P, 4, 0.6), { tone: "lo" });
for (let x = TRAY.x + 8; x < TRAY.x + TRAY.w - 4; x += 8) {
	s.line(lineOnTop([x, TRAY.y + 4], [x, TRAY.y + TRAY.d - 4], 4, s.P), {
		tone: "faint",
	});
}
// Tank on its plinth.
s.solid(slabOf(insetPlan(TANK, 4), 0, FEET, s.P, 6), { tone: "lo" });
s.solid(slabOf(TANK, FEET, TANK_H, s.P, 8, 1.2));
s.line(planOutline(insetPlan(TANK, 5), TOP, s.P, 6), { tone: "faint" });
// Seam where the lid meets the tank, on the two faces in view.
const seam = TOP - 18;
s.line(faceLine(s, "y", FRONT, TANK.x + 6, TANK.x + TANK.w - 6, seam), {
	tone: "faint",
});
s.line(faceLine(s, "x", TANK.x + TANK.w, TANK.y + 6, FRONT - 6, seam), {
	tone: "faint",
});
// Label plate on the front, above the taps.
s.line(faceRect(s, "y", FRONT, -24, 24, TOP - 14, TOP - 5), { tone: "mid" });
faceRules(s, "y", FRONT, -20, TOP - 8, [26, 18], 3);
// Sight glass on the side, showing the shared level.
const side = TANK.x + TANK.w;
s.line(faceRect(s, "x", side, -28, -20, FEET + 6, TOP - 6), { tone: "mid" });
s.line(faceLine(s, "x", side, -28, -20, FEET + 20), { tone: "lo" });
screws(
	s,
	[
		[TANK.x + 9, TANK.y + 9],
		[TANK.x + TANK.w - 9, TANK.y + 9],
		[TANK.x + TANK.w - 9, FRONT - 9],
	],
	TOP,
	1.5
);
// Filler funnel on top: where every install goes in. The one accent.
s.solid(cylinder(FILLER[0], FILLER[1], 9, TOP, 1.5, s.P, 32), { tone: "lo" });
s.solid(cylinder(FILLER[0], FILLER[1], 4, TOP + 1.5, 5, s.P, 24));
s.solid(cylinder(FILLER[0], FILLER[1], 10, TOP + 6.5, 6, s.P, 36, 0.4), {
	lit: true,
});
s.line(ring(FILLER[0], FILLER[1], 7, TOP + 12.5, s.P, 32), { tone: "lo" });
// One tap and one cup per agent, far to near.
for (const x of TAPS) {
	s.halo({ x: x - 6, y: FRONT + 3, w: 12, d: 12, r: 6 }, 4, 2);
	s.solid(cylinder(x, FRONT + 9, 6, 4, 8, s.P, 28, 0.4));
	s.line(ring(x, FRONT + 9, 4.8, 12, s.P, 24), { tone: "lo" });
	s.solid(cylinder(x, FRONT + 9, 1.8, 16, 6, s.P, 16), { tone: "lo" });
	s.solid(
		slabOf({ x: x - 2.5, y: FRONT, w: 5, d: 11.5, r: 1.2 }, 21, 4, s.P, 2)
	);
	s.solid(
		slabOf({ x: x - 1, y: FRONT + 1.5, w: 2, d: 2, r: 0.6 }, 25, 6, s.P, 2),
		{
			tone: "lo",
		}
	);
	s.solid(cylinder(x, FRONT + 2.5, 2.2, 31, 2.4, s.P, 16));
}

export const drawing = cardDrawing(s);
