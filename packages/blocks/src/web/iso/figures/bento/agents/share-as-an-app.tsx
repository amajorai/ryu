import {
	boxCorners,
	corners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, byDepth, faceLine } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Share as an App: a slatted shipping crate on a pallet, strapped and closed
 * with a seal on the lid (the lit part). The agent goes out packed whole; a
 * smaller sealed carton beside it is the copy already on its way.
 */

const PLATE = { x: -96, y: -56, w: 192, d: 112, r: 8 };
const PALLET = { x: -74, y: -42, w: 84, d: 80, r: 2 };
const CRATE = { x: -68, y: -36, w: 72, d: 68, r: 2 };
const DECK_Z = 9;
const CRATE_H = 40;
const LID_Z = DECK_Z + CRATE_H;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CRATE.x, CRATE.y, LID_Z + 8],
]);

benchPlate(s, PLATE);
// Pallet: six runner blocks under a boarded deck.
s.halo(PALLET, 0);
const blocks: [number, number][] = [
	...corners(PALLET, 6),
	[PALLET.x + PALLET.w / 2, PALLET.y + 6],
	[PALLET.x + PALLET.w / 2, PALLET.y + PALLET.d - 6],
];
for (const [x, y] of byDepth(blocks, s)) {
	s.solid(slabOf({ x: x - 5, y: y - 5, w: 10, d: 10, r: 1 }, 0, 6, s.P, 2), {
		tone: "lo",
	});
}
s.solid(slabOf(PALLET, 6, 3, s.P, 2, 0.4));
// The crate, its slat seams and corner battens.
s.solid(slabOf(CRATE, DECK_Z, CRATE_H, s.P, 2, 0.6));
const front = CRATE.y + CRATE.d;
const side = CRATE.x + CRATE.w;
for (let i = 1; i < 4; i++) {
	const z = DECK_Z + i * 10;
	s.line(faceLine(s, "y", front, CRATE.x + 6, side - 6, z), { tone: "faint" });
	s.line(faceLine(s, "x", side, CRATE.y + 6, front - 6, z), { tone: "faint" });
}
for (const [x, y, w, d] of [
	[CRATE.x - 1, front - 5, 6, 6],
	[side - 5, CRATE.y - 1, 6, 6],
	[side - 5, front - 5, 6, 6],
] as const) {
	s.solid(slabOf({ x, y, w, d, r: 0.6 }, DECK_Z, CRATE_H, s.P, 2), {
		tone: "lo",
		crease: "none",
	});
}
// Lid, strap and seal.
const lid = {
	x: CRATE.x - 2,
	y: CRATE.y - 2,
	w: CRATE.w + 4,
	d: CRATE.d + 4,
	r: 2,
};
s.solid(slabOf(lid, LID_Z, 4, s.P, 2, 0.6));
s.line(planOutline(insetPlan(lid, 6), LID_Z + 4, s.P, 2), { tone: "faint" });
const strapX = CRATE.x + CRATE.w / 2;
s.line(
	lineOnTop([strapX - 3, lid.y], [strapX - 3, lid.y + lid.d], LID_Z + 4, s.P),
	{
		tone: "mid",
	}
);
s.line(
	lineOnTop([strapX + 3, lid.y], [strapX + 3, lid.y + lid.d], LID_Z + 4, s.P),
	{
		tone: "mid",
	}
);
s.solid(
	cylinder(strapX, CRATE.y + CRATE.d / 2, 7, LID_Z + 4, 2.4, s.P, 32, 0.4),
	{
		lit: true,
	}
);
s.line(ring(strapX, CRATE.y + CRATE.d / 2, 4, LID_Z + 6.4, s.P, 24), {
	tone: "lo",
});
// The copy: a taped carton on the bench.
const carton = { x: 28, y: -14, w: 46, d: 40, r: 2 };
s.halo(carton, 0);
s.solid(slabOf(carton, 0, 24, s.P, 2, 0.6));
const tapeX = carton.x + carton.w / 2;
s.solid(
	slabOf(
		{ x: tapeX - 4, y: carton.y, w: 8, d: carton.d, r: 0 },
		24,
		0.6,
		s.P,
		1
	),
	{ tone: "lo", crease: "none" }
);
s.line(
	lineOnTop(
		[carton.x, carton.y + carton.d / 2],
		[tapeX - 4, carton.y + carton.d / 2],
		24,
		s.P
	),
	{
		tone: "faint",
	}
);
s.line(
	lineOnTop(
		[tapeX + 4, carton.y + carton.d / 2],
		[carton.x + carton.w, carton.y + carton.d / 2],
		24,
		s.P
	),
	{
		tone: "faint",
	}
);

export const drawing = cardDrawing(s);
