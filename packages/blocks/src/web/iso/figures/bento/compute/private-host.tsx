import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceLine,
	faceRect,
	faceRules,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Private host: a sealed host chassis. Work crosses its wall only through the
 * pass-through drawer on the left (the lit job block on the tray); the host's
 * own file drawers on the right are barred and padlocked, so they stay put.
 */

const PLATE = { x: -72, y: -54, w: 132, d: 114, r: 8 };
const BOX = { x: -56, y: -42, w: 100, d: 62, r: 4 };
const BOX_H = 36;
const FRONT = BOX.y + BOX.d;
const SIDE = BOX.x + BOX.w;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, BOX_H + 6]]);

benchPlate(s, PLATE);
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 6, 1.2));
s.line(planOutline(insetPlan(BOX, 6), BOX_H, s.P, 6), { tone: "faint" });
screws(
	s,
	[
		[BOX.x + 10, BOX.y + 10],
		[SIDE - 10, BOX.y + 10],
		[BOX.x + 10, FRONT - 10],
		[SIDE - 10, FRONT - 10],
	],
	BOX_H,
	1.6
);
lamp(s, [SIDE - 22, BOX.y + 12], BOX_H, { radius: 1.8 });
faceRules(s, "x", SIDE, BOX.y + 10, BOX_H - 8, [40, 40, 40, 40], 5);
// Host file drawers, barred and padlocked.
s.line(faceRect(s, "y", FRONT, 2, 38, 19, 31), { tone: "lo" });
s.line(faceRect(s, "y", FRONT, 2, 38, 5, 17), { tone: "lo" });
s.line(faceLine(s, "y", FRONT, 8, 16, 25), { tone: "mid" });
s.line(faceLine(s, "y", FRONT, 8, 16, 11), { tone: "mid" });
s.solid(slabOf({ x: 24, y: FRONT, w: 3, d: 2, r: 0.5 }, 3, 30, s.P, 2));
s.solid(slabOf({ x: 21, y: FRONT + 2, w: 9, d: 4, r: 1.5 }, 12, 8, s.P, 3), {
	tone: "lo",
});
// The pass-through hatch with its drawer slid out.
s.line(faceRect(s, "y", FRONT, -50, -6, 7, 25), { tone: "mid" });
const tray = { x: -46, y: FRONT, w: 36, d: 32, r: 2 };
s.solid(slabOf(tray, 9, 2, s.P, 3, 0.4), { tone: "lo" });
const job = { x: -38, y: FRONT + 6, w: 20, d: 16, r: 2 };
s.halo(job, 11);
s.solid(slabOf(job, 11, 10, s.P, 4, 0.6), { lit: true });
// The drawer's front lip, nearest the viewer, goes on last.
s.solid(slabOf({ ...tray, y: FRONT + 28, d: 4, r: 1 }, 11, 5, s.P, 3));

export const drawing = cardDrawing(s);
