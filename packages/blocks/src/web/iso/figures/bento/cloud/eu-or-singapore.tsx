import { boxCorners, cylinder, knurl, slabOf } from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * EU or Singapore: a double-throw knife switch. One blade, two contact clips,
 * one per region; the blade is thrown into one of them, and that region's
 * lamp is lit. The other clip waits open.
 */

const PLATE = { x: -92, y: -44, w: 184, d: 88, r: 8 };
const BASE = { x: -80, y: -30, w: 160, d: 60, r: 5 };
const BASE_H = 10;
const JAW_H = 13;
const BLADE_TOP = BASE_H + JAW_H + 9;
const CLIP_X = 48;
const HANDLE_X = CLIP_X + 12;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[HANDLE_X, 0, BLADE_TOP + 30],
]);

function jaw(x: number, y: number) {
	s.solid(
		slabOf({ x: x - 6, y: y - 2, w: 12, d: 4, r: 0.8 }, BASE_H, JAW_H, s.P, 2)
	);
}

function clipFoot(x: number) {
	s.solid(
		slabOf({ x: x - 10, y: -12, w: 20, d: 24, r: 2 }, BASE_H, 3, s.P, 3),
		{
			tone: "lo",
		}
	);
}

benchPlate(s, PLATE);
// Insulating base.
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 0.8));
screws(
	s,
	[
		[BASE.x + 8, BASE.y + 8],
		[BASE.x + 8, BASE.y + BASE.d - 8],
		[BASE.x + BASE.w - 8, BASE.y + 8],
		[BASE.x + BASE.w - 8, BASE.y + BASE.d - 8],
	],
	BASE_H,
	1.4
);
// The open clip on the left, empty.
clipFoot(-CLIP_X);
jaw(-CLIP_X, -5.5);
jaw(-CLIP_X, 5.5);
lamp(s, [-CLIP_X - 4, 22], BASE_H, { radius: 3 });
// Hinge: far cheek, then the blade, then the near cheek.
clipFoot(0);
s.solid(
	slabOf({ x: -7, y: -7.5, w: 14, d: 4, r: 0.8 }, BASE_H, JAW_H + 6, s.P, 2)
);
clipFoot(CLIP_X);
jaw(CLIP_X, -5.5);
s.solid(
	slabOf(
		{ x: -6, y: -2.5, w: CLIP_X + 22, d: 5, r: 1 },
		BLADE_TOP - 15,
		15,
		s.P,
		2
	)
);
s.solid(
	slabOf({ x: -7, y: 3.5, w: 14, d: 4, r: 0.8 }, BASE_H, JAW_H + 6, s.P, 2)
);
jaw(CLIP_X, 5.5);
// Insulated handle at the free end of the blade.
s.solid(cylinder(HANDLE_X, 0, 6, BLADE_TOP, 3, s.P, 24), { tone: "lo" });
s.solid(cylinder(HANDLE_X, 0, 5, BLADE_TOP + 3, 22, s.P, 28));
s.line(knurl(HANDLE_X, 0, 5, BLADE_TOP + 6, BLADE_TOP + 22, 20, s.P), {
	tone: "lo",
});
s.solid(cylinder(HANDLE_X, 0, 6.5, BLADE_TOP + 25, 4, s.P, 28), { tone: "lo" });
lamp(s, [CLIP_X - 4, 22], BASE_H, { lit: true, radius: 3 });

export const drawing = cardDrawing(s);
