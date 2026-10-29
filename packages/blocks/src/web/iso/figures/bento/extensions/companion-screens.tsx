import {
	boxCorners,
	cylinder,
	insetPlan,
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
 * Companion screens: a tool caddy with its own screen. The plugin's tools
 * stand in the open caddy, and beside it, wired to the caddy, a small monitor
 * on a stand shows the plugin's own page (the lit screen).
 */

const PLATE = { x: -96, y: -46, w: 190, d: 76, r: 8 };
const CADDY = { x: -84, y: -34, w: 76, d: 48, r: 4 };
const CADDY_H = 20;
const WALL = 4;
const HANDLE_Y = CADDY.y + CADDY.d / 2;
const SCREEN = { x: 14, y: -10, w: 64, d: 6, r: 1.5 };
const SCREEN_Z = 18;
const SCREEN_H = 40;
const FACE = SCREEN.y + SCREEN.d;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, 0, SCREEN_Z + SCREEN_H + 2],
	[-46, HANDLE_Y, CADDY_H + 26],
]);

benchPlate(s, PLATE);
// The caddy: an open box with tools standing in it and a carry handle.
s.halo(CADDY, 0);
s.solid(slabOf(CADDY, 0, CADDY_H, s.P, 6, 0.8));
const well = insetPlan(CADDY, WALL);
s.solid(slabOf(well, CADDY_H - 0.4, 0.4, s.P, 4), {
	tone: "lo",
	crease: "none",
});
s.line(planOutline(well, CADDY_H, s.P, 4), { tone: "mid" });
const handleX = [CADDY.x + 12, CADDY.x + CADDY.w - 12] as const;
const tools: [number, number, number][] = [
	[-70, -24, 16],
	[-58, -22, 12],
	[-30, -24, 14],
	[-22, -24, 10],
];
for (const [x, y, h] of tools) {
	s.solid(cylinder(x, y, 3.2, CADDY_H, h, s.P, 20, 0.6));
	s.solid(cylinder(x, y, 1.2, CADDY_H + h, 3, s.P, 12), { tone: "lo" });
}
s.solid(
	slabOf(
		{ x: handleX[0] - 2, y: HANDLE_Y - 3, w: 4, d: 6, r: 1 },
		CADDY_H,
		22,
		s.P,
		2
	)
);
s.solid(
	slabOf(
		{ x: handleX[1] - 2, y: HANDLE_Y - 3, w: 4, d: 6, r: 1 },
		CADDY_H,
		22,
		s.P,
		2
	)
);
s.solid(
	slabOf(
		{
			x: handleX[0] - 3,
			y: HANDLE_Y - 3,
			w: handleX[1] - handleX[0] + 6,
			d: 6,
			r: 2,
		},
		CADDY_H + 22,
		4,
		s.P,
		3,
		0.6
	)
);
for (const [x, y] of [
	[-68, 6],
	[-48, 6],
	[-28, 6],
] as const) {
	s.solid(
		slabOf({ x: x - 5, y: y - 3, w: 10, d: 6, r: 1 }, CADDY_H, 5, s.P, 2, 0.3),
		{
			tone: "lo",
		}
	);
}
s.line(faceRect(s, "y", CADDY.y + CADDY.d, CADDY.x + 10, CADDY.x + 30, 6, 13), {
	tone: "lo",
});
// The cable from the caddy to the monitor.
s.wire([CADDY.x + CADDY.w, 0, 6], [SCREEN.x + 18, -12, 0], [[4, 4, 0]], {
	tone: "lo",
});
// The monitor: a foot, a neck and the screen standing on it.
const foot = { x: 28, y: -18, w: 36, d: 22, r: 4 };
s.halo(foot, 0);
s.solid(slabOf(foot, 0, 3, s.P, 4, 0.6), { tone: "lo" });
screws(s, [[34, -13]], 3, 1.2);
s.solid(slabOf({ x: 42, y: -9.5, w: 8, d: 5, r: 1 }, 3, SCREEN_Z - 3, s.P, 2));
s.solid(slabOf(SCREEN, SCREEN_Z, SCREEN_H, s.P, 3, 0.6));
s.solid(
	slabOf(
		{ x: SCREEN.x + 4, y: FACE - 0.2, w: SCREEN.w - 8, d: 0.8, r: 0.4 },
		SCREEN_Z + 5,
		SCREEN_H - 9,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
faceRules(
	s,
	"y",
	FACE + 0.6,
	SCREEN.x + 10,
	SCREEN_Z + SCREEN_H - 10,
	[34, 44, 26],
	6
);
lamp(s, [SCREEN.x + SCREEN.w - 6, SCREEN.y + 3], SCREEN_Z + SCREEN_H, {
	radius: 1.4,
});
s.solid(
	cylinder(SCREEN.x + 8, SCREEN.y + 3, 1.6, SCREEN_Z + SCREEN_H, 1, s.P, 16),
	{
		tone: "lo",
	}
);

export const drawing = cardDrawing(s);
