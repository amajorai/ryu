import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRules, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Files and previews: a workspace crate with its preview screen standing on
 * the lid (the lit glass) and an out-tray bolted to its side holding the
 * sheets it produced. Screen and tray travel with the crate they belong to.
 */

const PLATE = { x: -96, y: -48, w: 192, d: 96, r: 8 };
const CRATE = { x: -80, y: -34, w: 92, d: 64, r: 5 };
const CRATE_H = 24;
const SCREEN = { x: -70, y: -28, w: 72, d: 5, r: 1 };
const SCREEN_Z = CRATE_H + 8;
const SCREEN_H = 42;
const TRAY = { x: 22, y: -22, w: 56, d: 48, r: 3 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-34, -28, SCREEN_Z + SCREEN_H + 2],
]);

benchPlate(s, PLATE);
s.halo(CRATE, 0);
s.solid(slabOf(CRATE, 0, CRATE_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(CRATE, 5), CRATE_H, s.P, 4), { tone: "faint" });
faceRules(s, "y", CRATE.y + CRATE.d, CRATE.x + 10, CRATE_H - 6, [26, 18], 5);
screws(
	s,
	[
		[CRATE.x + 8, CRATE.y + CRATE.d - 8],
		[CRATE.x + CRATE.w - 8, CRATE.y + CRATE.d - 8],
	],
	CRATE_H,
	1.4
);
// Screen on two short posts at the back of the lid.
for (const x of [SCREEN.x + 14, SCREEN.x + SCREEN.w - 14]) {
	s.solid(
		cylinder(x, SCREEN.y + 2.5, 3, CRATE_H, SCREEN_Z - CRATE_H, s.P, 20),
		{
			tone: "lo",
		}
	);
}
s.solid(slabOf(SCREEN, SCREEN_Z, SCREEN_H, s.P, 3, 0.6));
s.solid(
	slabOf(
		{ x: SCREEN.x + 5, y: SCREEN.y + SCREEN.d, w: SCREEN.w - 10, d: 0.8, r: 0 },
		SCREEN_Z + 5,
		SCREEN_H - 10,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
lamp(s, [CRATE.x + CRATE.w - 12, CRATE.y + 30], CRATE_H, { radius: 1.8 });
// Out-tray on the side, a short stack of produced sheets in it.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 8, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(insetPlan(TRAY, 3), 8, 0.4, s.P, 3), {
	tone: "lo",
	crease: "none",
});
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf(
			{ x: TRAY.x + 8 + i * 2, y: TRAY.y + 8 - i * 2, w: 36, d: 30, r: 1 },
			4 + i * 2.2,
			1.6,
			s.P,
			2
		),
		{ crease: "none" }
	);
}

export const drawing = cardDrawing(s);
