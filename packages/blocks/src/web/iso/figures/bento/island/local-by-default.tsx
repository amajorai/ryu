import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	faceRules,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Local by default: a screen and the small model box that reads it, wired
 * together on one bench. The cable never leaves the plate; the model chip
 * seated in the box (the lit part) is where the reading happens.
 */

const PLATE = { x: -84, y: -50, w: 168, d: 96, r: 8 };
const FOOT = { x: -44, y: -46, w: 32, d: 20, r: 3 };
const PANEL = { x: -76, y: -40, w: 96, d: 5, r: 1.5 };
const PANEL_Z = 14;
const PANEL_TOP = 62;
const FACE = PANEL.y + PANEL.d;
const BOX = { x: 22, y: -14, w: 54, d: 52, r: 4 };
const BOX_H = 26;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[PANEL.x, PANEL.y, PANEL_TOP],
	[PANEL.x + PANEL.w, PANEL.y, PANEL_TOP],
]);

benchPlate(s, PLATE);
// The screen on its stand.
s.halo(FOOT, 0);
s.solid(slabOf(FOOT, 0, 3, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf({ x: -32, y: -46, w: 8, d: 6, r: 1 }, 3, 20, s.P, 2));
s.solid(slabOf(PANEL, PANEL_Z, PANEL_TOP - PANEL_Z, s.P, 3, 0.6));
s.line(faceRect(s, "y", FACE, PANEL.x + 5, PANEL.x + PANEL.w - 5, 18, 58), {
	tone: "mid",
});
faceRules(s, "y", FACE, PANEL.x + 11, 52, [64, 46, 72, 38, 56], 7);
// The cable stays on the bench, from the stand to the box.
s.wire([-28, -26, 0], [BOX.x, 4, 0], [[-28, 4, 0]]);
// The model box: vents, a status lamp, and the chip in its socket.
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BOX, 4), BOX_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[BOX.x + 8, BOX.y + 8],
		[BOX.x + BOX.w - 8, BOX.y + BOX.d - 8],
	],
	BOX_H,
	1.4
);
for (let i = 0; i < 5; i++) {
	const y = BOX.y + 12 + i * 6;
	s.line(lineOnTop([BOX.x + 40, y], [BOX.x + 48, y], BOX_H, s.P), {
		tone: "lo",
	});
}
const socket = { x: BOX.x + 7, y: BOX.y + 12, w: 28, d: 28, r: 2 };
s.solid(slabOf(socket, BOX_H, 2, s.P, 3), { tone: "lo" });
s.solid(slabOf(insetPlan(socket, 4), BOX_H + 2, 4, s.P, 3, 0.4), {
	lit: true,
});
lamp(s, [BOX.x + BOX.w - 10, BOX.y + BOX.d - 10], BOX_H, { radius: 1.8 });

export const drawing = cardDrawing(s);
