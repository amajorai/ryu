import {
	boxCorners,
	cylinder,
	dotGrid,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Apps and sandbox: a rack of app blocks beside a walled sand tray. A small
 * crane sets the lit app block down inside the tray, where whatever it does
 * stays within the walls.
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const RACK = { x: -90, y: -44, w: 34, d: 88, r: 3 };
const TRAY = { x: -42, y: -42, w: 128, d: 84, r: 5 };
const WALL = 18;
const SAND = 8;
const CRANE: [number, number] = [24, -25];
const BLOCK = { x: 14, y: 0, w: 20, d: 20, r: 2 };
const BLOCK_H = 14;
const BOOM_Z = 46;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CRANE[0], CRANE[1], BOOM_Z + 6],
]);

benchPlate(s, PLATE);
// App rack: a slotted shelf holding the installed app blocks.
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, 6, s.P, 4, 0.6));
for (const y of [-38, -12, 14]) {
	const app = { x: RACK.x + 6, y, w: 22, d: 22, r: 3 };
	s.solid(slabOf(app, 6, 18, s.P, 4, 0.8));
	s.line(planOutline(insetPlan(app, 5), 24, s.P, 3), { tone: "faint" });
}
// Sand tray: a sunken sand floor ringed by thick walls. The far walls draw
// first, the near walls last, so the crane and block sit down inside.
const T = 7;
const walls = {
	back: { x: TRAY.x, y: TRAY.y, w: TRAY.w, d: T, r: 2 },
	left: { x: TRAY.x, y: TRAY.y, w: T, d: TRAY.d, r: 2 },
	front: { x: TRAY.x, y: TRAY.y + TRAY.d - T, w: TRAY.w, d: T, r: 2 },
	right: { x: TRAY.x + TRAY.w - T, y: TRAY.y, w: T, d: TRAY.d, r: 2 },
};
const pit = insetPlan(TRAY, T);
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, SAND, s.P, 8, 1), { tone: "lo" });
s.solid(slabOf(walls.back, SAND, WALL - SAND, s.P, 2));
s.solid(slabOf(walls.left, SAND, WALL - SAND, s.P, 2));
s.dots(dotGrid(pit.x + 6, pit.y + 6, 13, 8, 8.4, SAND, s.P), {
	size: 0.4,
	tone: "faint",
});
screws(s, [[TRAY.x + 3.5, TRAY.y + 3.5]], WALL, 1.3);
lamp(s, [TRAY.x + TRAY.w - 16, TRAY.y + 3.5], WALL, { radius: 1.6 });
// Crane: a mast on the sand with a boom reaching over the block.
s.solid(cylinder(CRANE[0], CRANE[1], 7, SAND, 3, s.P, 28), { tone: "lo" });
s.solid(
	cylinder(CRANE[0], CRANE[1], 3.5, SAND + 3, BOOM_Z - SAND - 3, s.P, 24)
);
s.solid(
	slabOf(
		{ x: CRANE[0] - 3, y: CRANE[1] - 5, w: 6, d: 45, r: 1 },
		BOOM_Z,
		5,
		s.P,
		2
	)
);
const cx = BLOCK.x + BLOCK.w / 2;
const cy = BLOCK.y + BLOCK.d / 2;
s.halo(BLOCK, SAND);
s.solid(slabOf(BLOCK, SAND, BLOCK_H, s.P, 4, 0.8), { lit: true });
s.solid(cylinder(cx, cy, 5, SAND + BLOCK_H, 3, s.P, 24), { tone: "lo" });
s.solid(
	cylinder(
		cx,
		cy,
		1.2,
		SAND + BLOCK_H + 3,
		BOOM_Z - SAND - BLOCK_H - 3,
		s.P,
		12
	)
);
s.solid(slabOf(walls.right, SAND, WALL - SAND, s.P, 2));
s.solid(slabOf(walls.front, SAND, WALL - SAND, s.P, 2));
screws(s, [[TRAY.x + TRAY.w - 3.5, TRAY.y + TRAY.d - 3.5]], WALL, 1.3);

export const drawing = cardDrawing(s);
