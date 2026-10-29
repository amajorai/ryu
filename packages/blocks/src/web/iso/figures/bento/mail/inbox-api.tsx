import {
	boxCorners,
	cylinder,
	lineOnTop,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Inbox API: a rack of mail pigeonholes run from one control box. Each cubby
 * is an inbox; the single box in front is the one API that lists, opens,
 * renames and closes them, worked by one lever (the lit handle).
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const RACK = { x: -80, y: -40, w: 104, d: 30, r: 3 };
const RACK_H = 54;
const FRONT = RACK.y + RACK.d;
const COLS = 3;
const ROWS = 2;
const CELL_W = (RACK.w - 8) / COLS;
const CELL_H = (RACK_H - 8) / ROWS;
const BOX = { x: 36, y: -4, w: 48, d: 46, r: 4 };
const BOX_H = 18;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners(RACK, 0, RACK_H),
]);

benchPlate(s, PLATE);
// The pigeonhole rack: a cabinet with open cubbies on its front face.
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 4, 1));
const filled = [true, false, true, true, true, false];
for (let row = 0; row < ROWS; row++) {
	for (let col = 0; col < COLS; col++) {
		const x0 = RACK.x + 4 + col * CELL_W + 2;
		const x1 = x0 + CELL_W - 4;
		const z0 = 4 + row * CELL_H + 2;
		s.line(faceRect(s, "y", FRONT, x0, x1, z0, z0 + CELL_H - 4), {
			tone: "lo",
		});
		if (filled[row * COLS + col]) {
			// A letter lying in the cubby, poking out past the face.
			s.solid(
				slabOf(
					{ x: x0 + 3, y: FRONT - 6, w: CELL_W - 10, d: 12, r: 0.5 },
					z0 + 0.5,
					2,
					s.P,
					2
				),
				{ crease: "none" }
			);
		}
	}
}
screws(
	s,
	[
		[RACK.x + 8, RACK.y + 8],
		[RACK.x + RACK.w - 8, RACK.y + 8],
	],
	RACK_H,
	1.6
);
// The cable from the rack's front, across the plate, into the control box.
s.wire(
	[RACK.x + 90, FRONT, 5],
	[BOX.x + 4, BOX.y + 20, 1.5],
	[
		[RACK.x + 90, FRONT + 4, 1.5],
		[RACK.x + 90, BOX.y + 20, 1.5],
	]
);
// The control box: one lever and three lamps; the lever handle is lit.
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 6, 0.8));
screws(
	s,
	[
		[BOX.x + 6, BOX.y + 6],
		[BOX.x + BOX.w - 6, BOX.y + BOX.d - 6],
	],
	BOX_H,
	1.4
);
const pivot: [number, number] = [BOX.x + 16, BOX.y + 24];
s.line(
	lineOnTop([pivot[0], pivot[1] - 10], [pivot[0], pivot[1] + 10], BOX_H, s.P),
	{
		tone: "lo",
	}
);
s.solid(cylinder(pivot[0], pivot[1], 4, BOX_H, 2, s.P, 24), { tone: "lo" });
s.solid(cylinder(pivot[0], pivot[1] - 4, 1.8, BOX_H + 2, 20, s.P, 12));
s.solid(cylinder(pivot[0], pivot[1] - 4, 4.2, BOX_H + 22, 6, s.P, 24, 0.6), {
	lit: true,
});
lamp(s, [BOX.x + 36, BOX.y + 12], BOX_H, { radius: 2.6 });
lamp(s, [BOX.x + 36, BOX.y + 22], BOX_H);
lamp(s, [BOX.x + 36, BOX.y + 32], BOX_H);

export const drawing = cardDrawing(s);
