import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, byDepth, knob, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Scoped agent access: a shadow tray that is one agent's kit. Of its six
 * sockets only two hold a tool (the lit one is in use); the rest stay empty.
 * The selector box beside it sets what the agent may run.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const TRAY = { x: -82, y: -38, w: 116, d: 76, r: 5 };
const TRAY_H = 10;
const BOX = { x: 48, y: -26, w: 34, d: 52, r: 4 };
const BOX_H = 16;
const TOOL_H = 22;

type Socket = [number, number, "empty" | "tool" | "lit"];
const SOCKETS: Socket[] = [
	[-56, -16, "empty"],
	[-24, -16, "tool"],
	[8, -16, "empty"],
	[-56, 16, "empty"],
	[-24, 16, "empty"],
	[8, 16, "lit"],
];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[8, 16, TRAY_H + TOOL_H + 10],
]);

benchPlate(s, PLATE);
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 6, 1));
s.line(planOutline(insetPlan(TRAY, 5), TRAY_H, s.P, 4), { tone: "faint" });
for (const [x, y, kind] of byDepth(SOCKETS, s, TRAY_H)) {
	s.line(ring(x, y, 11, TRAY_H, s.P, 32), { tone: "lo" });
	if (kind === "empty") {
		s.line(ring(x, y, 6.5, TRAY_H, s.P, 24), { tone: "faint" });
		continue;
	}
	// A tool: knurled grip with a shank and tip above it.
	s.solid(cylinder(x, y, 9, TRAY_H, TOOL_H, s.P, 32, 0.6), {
		lit: kind === "lit",
	});
	s.line(knurl(x, y, 9, TRAY_H + 4, TRAY_H + TOOL_H - 4, 28, s.P), {
		tone: "lo",
	});
	s.solid(cylinder(x, y, 3, TRAY_H + TOOL_H, 10, s.P, 16), { tone: "lo" });
}
// Selector box: a rotary switch and two screws.
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 5, 0.8));
s.line(planOutline(insetPlan(BOX, 4), BOX_H, s.P, 3), { tone: "faint" });
screws(
	s,
	[
		[BOX.x + 8, BOX.y + 8],
		[BOX.x + BOX.w - 8, BOX.y + BOX.d - 8],
	],
	BOX_H,
	1.4
);
knob(s, [BOX.x + BOX.w / 2, BOX.y + BOX.d / 2], BOX_H, 7, 6);

export const drawing = cardDrawing(s);
