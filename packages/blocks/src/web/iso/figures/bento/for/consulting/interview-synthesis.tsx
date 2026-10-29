import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, faceRect, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Interview synthesis: a sorting hopper. Interview notes go in through the
 * slot on top and fall sorted into three bins (themes, quotes, implications).
 * Nothing leaves until it has been checked: the hold lamp on the gate post
 * (the lit part) stays on until you validate the batch.
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const HOPPER: [number, number] = [-34, -22];
const LEG_H = 18;
const BODY_H = 24;
const BIN_Y = 8;
const BIN_D = 34;
const BIN_H = 14;
const BINS = [-80, -44, -8];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[HOPPER[0], HOPPER[1], LEG_H + BODY_H + 12],
]);

benchPlate(s, PLATE);
// Hopper on four legs, with notes standing in its feed slot.
const [hx, hy] = HOPPER;
s.halo({ x: hx - 22, y: hy - 22, w: 44, d: 44, r: 22 }, 0);
const legs: [number, number][] = [
	[hx - 14, hy - 14],
	[hx + 14, hy - 14],
	[hx - 14, hy + 14],
	[hx + 14, hy + 14],
];
for (const [x, y] of byDepth(legs, s)) {
	s.solid(cylinder(x, y, 2.4, 0, LEG_H, s.P, 16));
}
s.solid(cylinder(hx, hy, 8, LEG_H - 4, 4, s.P, 28), { tone: "lo" });
s.solid(cylinder(hx, hy, 22, LEG_H, BODY_H, s.P, 48, 0.8));
const top = LEG_H + BODY_H;
s.line(ring(hx, hy, 18, top, s.P, 48), { tone: "lo" });
s.line(knurl(hx, hy, 22, LEG_H + 3, LEG_H + 6, 40, s.P), { tone: "faint" });
const slot = { x: hx - 12, y: hy - 3, w: 24, d: 6, r: 1 };
s.solid(slabOf(slot, top, 1, s.P, 2), { tone: "lo", crease: "none" });
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf(
			{ x: hx - 9 + i * 6, y: hy - 1.5, w: 5, d: 3, r: 0.4 },
			top + 1,
			10 - i * 3,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
// Three bins in a tray, each holding its sorted cards.
const tray = { x: -86, y: BIN_Y - 4, w: 116, d: BIN_D + 8, r: 4 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 3, s.P, 6, 0.6), { tone: "lo" });
BINS.forEach((x, index) => {
	const bin = { x, y: BIN_Y, w: 32, d: BIN_D, r: 3 };
	s.solid(slabOf(bin, 3, BIN_H, s.P, 4, 0.6));
	s.line(planOutline(insetPlan(bin, 3), 3 + BIN_H, s.P, 3), { tone: "lo" });
	for (let c = 0; c < 2 + index; c++) {
		s.solid(
			slabOf(
				{ x: x + 6, y: BIN_Y + 6 + c * 6, w: 20, d: 2, r: 0.4 },
				3 + BIN_H,
				4,
				s.P,
				2
			),
			{ crease: "none" }
		);
	}
	s.line(faceRect(s, "y", BIN_Y + BIN_D, x + 10, x + 22, 8, 12), {
		tone: "mid",
	});
});
// Gate post with the hold lamp.
const post = { x: 52, y: -2, w: 22, d: 30, r: 3 };
s.halo(post, 0);
s.solid(slabOf(post, 0, 26, s.P, 4, 0.8));
s.line(planOutline(insetPlan(post, 4), 26, s.P, 3), { tone: "faint" });
lamp(s, [63, 6], 26, { lit: true, radius: 3 });
s.solid(cylinder(63, 18, 3.5, 26, 3, s.P, 20), { tone: "lo" });

export const drawing = cardDrawing(s);
