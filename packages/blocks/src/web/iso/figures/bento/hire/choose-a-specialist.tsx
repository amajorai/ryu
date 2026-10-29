import {
	boxCorners,
	cylinder,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Choose a specialist: a rack of agent cartridges, each capped with the tool
 * it is for (a dial, a lens, a lamp). One has been drawn out of its slot
 * (the empty one) along its rails onto the selection pad in front, lamp lit:
 * picked by what it does, chosen on the outcome dial beside it.
 */

const PLATE = { x: -92, y: -50, w: 160, d: 100, r: 8 };
const RACK = { x: -80, y: -40, w: 126, d: 34, r: 4 };
const RACK_H = 10;
const SLOTS = 5;
const PICKED = 3;
const PITCH = 24;
const CART_W = 14;
const CART_D = 22;
const HEIGHTS = [30, 24, 34, 0, 28];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-60, -30, 46]]);

const slotPlan = (index: number) => ({
	x: RACK.x + 8 + index * PITCH,
	y: RACK.y + 6,
	w: CART_W,
	d: CART_D,
	r: 2,
});

function cap(index: number, cx: number, cy: number, top: number) {
	const kind = index % 3;
	if (kind === 0) {
		knob(s, [cx, cy], top, 4, 4);
	} else if (kind === 1) {
		s.solid(cylinder(cx, cy, 5, top, 2, s.P, 28), { tone: "lo" });
		s.line(ring(cx, cy, 3, top + 2, s.P, 24), { tone: "mid" });
	} else {
		lamp(s, [cx, cy], top, { radius: 2.4 });
	}
}

benchPlate(s, PLATE);
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 6, 0.8));
for (let i = 0; i < SLOTS; i++) {
	const plan = slotPlan(i);
	const height = HEIGHTS[i] ?? 0;
	if (i === PICKED || height === 0) {
		s.line(planOutline(plan, RACK_H, s.P, 3), { tone: "mid" });
		continue;
	}
	s.solid(slabOf(plan, RACK_H, height, s.P, 4, 0.6));
	cap(i, plan.x + CART_W / 2, plan.y + CART_D / 2, RACK_H + height);
}
// The outcome selector dial on the left of the bench.
const dialBase = { x: -76, y: 10, w: 30, d: 28, r: 4 };
s.halo(dialBase, 0);
s.solid(slabOf(dialBase, 0, 4, s.P, 4, 0.6), { tone: "lo" });
screws(
	s,
	[
		[dialBase.x + 4, dialBase.y + 4],
		[dialBase.x + dialBase.w - 4, dialBase.y + dialBase.d - 4],
	],
	4,
	1.2
);
knob(s, [dialBase.x + 15, dialBase.y + 14], 4, 7, 6);
// Pull-out rails from the empty slot to the selection pad.
const empty = slotPlan(PICKED);
for (const dx of [2, CART_W - 4]) {
	s.solid(
		slabOf(
			{ x: empty.x + dx, y: RACK.y + RACK.d, w: 2, d: 10, r: 0.5 },
			0,
			1.5,
			s.P,
			2
		),
		{ tone: "lo" }
	);
}
// The selection pad in front, holding the chosen cartridge.
const pad = { x: empty.x - 15, y: RACK.y + RACK.d + 10, w: 44, d: 34, r: 4 };
s.halo(pad, 0);
s.solid(slabOf(pad, 0, 4, s.P, 4, 0.6), { tone: "lo" });
screws(
	s,
	[
		[pad.x + 5, pad.y + 5],
		[pad.x + pad.w - 5, pad.y + pad.d - 5],
	],
	4,
	1.2
);
const picked = { x: empty.x, y: pad.y + 6, w: CART_W, d: CART_D, r: 2 };
s.halo(picked, 4);
s.solid(slabOf(picked, 4, 30, s.P, 4, 0.6));
lamp(s, [picked.x + CART_W / 2, picked.y + CART_D / 2], 34, {
	lit: true,
	radius: 3,
});

export const drawing = cardDrawing(s);
