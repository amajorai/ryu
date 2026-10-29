import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	byDepth,
	faceRect,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Engagement survey analysis: a locked ballot box takes every answer slip
 * through its top slot; nothing comes back out but counters, sorted into
 * theme trays in front. The largest theme's stack is topped by the lit
 * counter. No single slip is ever shown.
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const BOX = { x: -84, y: -36, w: 56, d: 60, r: 4 };
const BOX_H = 40;
const TRAYS: [number, number, number][] = [
	[8, -20, 3],
	[42, -20, 5],
	[8, 18, 2],
	[42, 18, 4],
];
const TRAY = 28;
const CHIP_H = 3.4;
const TALLEST = 1;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-56, -6, BOX_H + 12],
]);

benchPlate(s, PLATE);
// Ballot box: body, lid rim, slot with a slip going in, lock on the front.
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BOX, 4), BOX_H, s.P, 4), { tone: "faint" });
const slot = { x: BOX.x + 26, y: BOX.y + 14, w: 5, d: 32, r: 1.5 };
s.line(planOutline(slot, BOX_H, s.P, 3), { tone: "mid" });
s.solid(
	slabOf(
		{ x: slot.x + 1.5, y: slot.y + 4, w: 1.4, d: 22, r: 0.3 },
		BOX_H,
		10,
		s.P,
		2
	),
	{
		crease: "none",
	}
);
const front = BOX.y + BOX.d;
s.line(faceRect(s, "y", front, BOX.x + 6, BOX.x + BOX.w - 6, 6, BOX_H - 8), {
	tone: "faint",
});
s.solid(
	slabOf({ x: BOX.x + 21, y: front, w: 14, d: 3, r: 1 }, 14, 12, s.P, 2, 0.4),
	{
		tone: "lo",
	}
);
screws(
	s,
	[
		[BOX.x + 8, BOX.y + 8],
		[BOX.x + BOX.w - 8, BOX.y + 8],
	],
	BOX_H,
	1.4
);
// Theme trays, each holding a stack of counters.
for (const [x, y, count] of byDepth(TRAYS, s)) {
	const plan = { x, y: y - TRAY / 2, w: TRAY, d: TRAY, r: 3 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, 4, s.P, 4, 0.6), { tone: "lo" });
	const cx = x + TRAY / 2;
	for (let i = 0; i < count; i++) {
		const lit =
			TRAYS[TALLEST]?.[0] === x && TRAYS[TALLEST]?.[1] === y && i === count - 1;
		s.solid(cylinder(cx, y, 9, 4 + i * CHIP_H, CHIP_H - 0.4, s.P, 32, 0.4), {
			lit,
		});
	}
	s.line(ring(cx, y, 5, 4 + count * CHIP_H - 0.4, s.P, 24), { tone: "faint" });
}

export const drawing = cardDrawing(s);
