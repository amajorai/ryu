import { boxCorners, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Vendor research and diligence: a card-index file of supplier profiles.
 * Every vendor has a card behind a divider; the one under review is pulled up
 * out of the file (the lit card) so its offerings and risk notes can be read.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const BOX = { x: -58, y: -38, w: 92, d: 72, r: 3 };
const BOX_H = 26;
const WALL = 4;
const CARDS = 9;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-10, -10, 64]]);

function card(y: number, height: number, lit = false) {
	const plan = {
		x: BOX.x + WALL + 3,
		y,
		w: BOX.w - 2 * WALL - 6,
		d: 1.6,
		r: 0,
	};
	s.solid(slabOf(plan, WALL, height, s.P, 1), { lit, crease: "none" });
}

benchPlate(s, PLATE);
s.halo(BOX, 0);
// The file box as floor, far walls, cards, then the near walls.
s.solid(slabOf(BOX, 0, WALL, s.P, 4), { tone: "lo" });
s.solid(slabOf({ ...BOX, d: WALL, r: 1 }, WALL, BOX_H - WALL, s.P, 2));
s.solid(slabOf({ ...BOX, w: WALL, r: 1 }, WALL, BOX_H - WALL, s.P, 2));
for (let i = 0; i < CARDS; i++) {
	const y = BOX.y + WALL + 6 + i * 6.4;
	const raised = i === 4;
	card(y, raised ? BOX_H + 26 : BOX_H + 4 - (i % 3) * 2, raised);
}
s.solid(
	slabOf(
		{ x: BOX.x + BOX.w - WALL, y: BOX.y, w: WALL, d: BOX.d, r: 1 },
		WALL,
		BOX_H - WALL,
		s.P,
		2
	)
);
const front = { x: BOX.x, y: BOX.y + BOX.d - WALL, w: BOX.w, d: WALL, r: 1 };
s.solid(slabOf(front, WALL, BOX_H - WALL, s.P, 2));
// Label holder and pull on the front face.
s.line(faceRect(s, "y", BOX.y + BOX.d, BOX.x + 30, BOX.x + 62, 14, 22), {
	tone: "mid",
});
s.solid(
	slabOf({ x: BOX.x + 38, y: BOX.y + BOX.d, w: 16, d: 3, r: 1 }, 8, 3, s.P, 2),
	{ tone: "lo" }
);
// A clipped stack of filed reports beside the box.
const stack = { x: 46, y: -14, w: 36, d: 44, r: 2 };
s.halo(stack, 0);
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf({ ...stack, x: stack.x + i, y: stack.y - i }, i * 2.4, 2.4, s.P, 2),
		{
			crease: "none",
			tone: i === 2 ? "hi" : "mid",
		}
	);
}
s.solid(slabOf({ x: 56, y: -18, w: 16, d: 8, r: 1.5 }, 7.2, 2.4, s.P, 2), {
	tone: "lo",
});
screws(s, [[64, 22]], 7.2, 1.4);
lamp(s, [72, 22], 7.2, { radius: 1.6 });

export const drawing = cardDrawing(s);
