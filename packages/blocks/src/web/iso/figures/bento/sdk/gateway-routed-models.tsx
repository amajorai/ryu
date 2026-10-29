import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	byDepth,
	jack,
	knob,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Gateway-routed models: a junction box wired in front of three model
 * canisters. Your code's one lead plugs into the box, and every canister is
 * fed only from the box, never directly; its lamp (the lit part) shows the
 * call passing through.
 */

const PLATE = { x: -92, y: -56, w: 184, d: 102, r: 8 };
const BOX = { x: -24, y: 8, w: 68, d: 30, r: 4 };
const BOX_H = 18;
const CAN_H = 30;
const CANS: [number, number][] = [
	[-72, -4],
	[-34, -34],
	[14, -38],
];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-34, -34, CAN_H + 14],
]);

function canister([x, y]: [number, number]) {
	s.halo({ x: x - 15, y: y - 15, w: 30, d: 30, r: 15 }, 0);
	s.solid(cylinder(x, y, 15, 0, 3, s.P, 40, 0.6), { tone: "lo" });
	s.solid(cylinder(x, y, 12, 3, CAN_H - 3, s.P, 40, 0.6));
	s.line(knurl(x, y, 12, CAN_H - 9, CAN_H, 30, s.P), { tone: "lo" });
	s.line(ring(x, y, 8, CAN_H, s.P, 32), { tone: "faint" });
	s.solid(cylinder(x, y, 3, CAN_H, 4, s.P, 20), { tone: "lo" });
}

benchPlate(s, PLATE);
for (const can of byDepth(CANS, s)) {
	canister(can);
}
// Leads from the box's top terminals back to each canister's cap.
CANS.forEach(([x, y], i) => {
	const tx = BOX.x + 14 + i * 20;
	const mid: [number, number, number] = [
		(tx + x) / 2,
		(BOX.y + 8 + y) / 2,
		CAN_H + 10,
	];
	s.wire([tx, BOX.y + 8, BOX_H], [x, y, CAN_H + 4], [mid], { tone: "mid" });
});
// The junction box itself.
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BOX, 4), BOX_H, s.P, 4), { tone: "faint" });
for (let i = 0; i < 3; i++) {
	jack(s, [BOX.x + 14 + i * 20, BOX.y + 8], BOX_H);
}
screws(
	s,
	[
		[BOX.x + 5, BOX.y + BOX.d - 5],
		[BOX.x + BOX.w - 5, BOX.y + BOX.d - 5],
	],
	BOX_H,
	1.2
);
knob(s, [BOX.x + 18, BOX.y + 21], BOX_H, 4, 4);
lamp(s, [BOX.x + BOX.w - 18, BOX.y + 20], BOX_H, { lit: true, radius: 5 });
// Your code's one lead, from a plug on the bench into the box's side.
const PLUG = { x: 70, y: 24, w: 16, d: 12, r: 2 };
s.wire([PLUG.x, PLUG.y + 6, 4], [BOX.x + BOX.w, BOX.y + 15, 9], [[57, 28, 3]], {
	tone: "mid",
});
s.halo(PLUG, 0);
s.solid(slabOf(PLUG, 0, 7, s.P, 3, 0.6));

export const drawing = cardDrawing(s);
