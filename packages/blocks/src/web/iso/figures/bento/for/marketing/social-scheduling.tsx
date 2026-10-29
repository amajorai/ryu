import {
	boxCorners,
	cylinder,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Social scheduling: a week rack. Seven drafted posts stand in the rack's
 * day slots, queued in order; at the end of the line the sign-off box waits
 * for a person to press its button (the lit part) before anything goes out.
 */

const PLATE = { x: -104, y: -48, w: 208, d: 96, r: 8 };
const RACK = { x: -92, y: -24, w: 132, d: 40, r: 4 };
const RACK_H = 10;
const GAP = 17;
const BOX = { x: 54, y: -20, w: 34, d: 36, r: 4 };
const BOX_H = 16;
const HEIGHTS = [22, 26, 20, 28, 24, 18, 26];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[RACK.x + 10, RACK.y + 8, RACK_H + 30],
]);

benchPlate(s, PLATE);
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 6, 0.8));
screws(
	s,
	[
		[RACK.x + 6, RACK.y + 6],
		[RACK.x + RACK.w - 6, RACK.y + RACK.d - 6],
	],
	RACK_H,
	1.4
);
// Day slots, each with a drafted post standing in it.
HEIGHTS.forEach((height, day) => {
	const x = RACK.x + 14 + day * GAP;
	s.line(
		lineOnTop(
			[x - 1.5, RACK.y + 5],
			[x - 1.5, RACK.y + RACK.d - 5],
			RACK_H,
			s.P
		),
		{
			tone: "lo",
		}
	);
	s.solid(
		slabOf(
			{ x: x - 1.2, y: RACK.y + 7, w: 2.4, d: RACK.d - 14, r: 0.4 },
			RACK_H,
			height,
			s.P,
			2
		),
		{ crease: "none" }
	);
	s.line(
		lineOnTop(
			[x + 1.2, RACK.y + 10],
			[x + 1.2, RACK.y + 20],
			RACK_H + height,
			s.P
		),
		{ tone: "faint" }
	);
});
// Sign-off box at the end of the queue.
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 6, 1));
lamp(s, [BOX.x + 8, BOX.y + 7], BOX_H, { radius: 1.6 });
lamp(s, [BOX.x + 15, BOX.y + 7], BOX_H, { radius: 1.6 });
s.solid(cylinder(BOX.x + 17, BOX.y + 22, 9, BOX_H, 2, s.P, 32), { tone: "lo" });
s.solid(cylinder(BOX.x + 17, BOX.y + 22, 7, BOX_H + 2, 4, s.P, 32, 0.8), {
	lit: true,
});

export const drawing = cardDrawing(s);
