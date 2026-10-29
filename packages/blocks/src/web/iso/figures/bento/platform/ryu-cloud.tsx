import {
	boxCorners,
	corners,
	cylinder,
	dotGrid,
	insetPlan,
	lineOnTop,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	faceRules,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Ryu Cloud: a hosted server cabinet on a raised floor. A column of rack
 * units with status lights, an exhaust fan on the roof, and one unit (the
 * lit part) slid out on its rails: the node running your agents.
 */

const PLATE = { x: -86, y: -52, w: 172, d: 90, r: 8 };
const CAB = { x: -46, y: -42, w: 52, d: 50, r: 2 };
const CAB_H = 84;
const UNITS = 6;
const UNIT_H = (CAB_H - 18) / UNITS;
const PULLED = 3;
const PULL = 16;
const SIDE = { x: 22, y: -42, w: 40, d: 50, r: 2 };
const SIDE_H = 34;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CAB.x, CAB.y, CAB_H + 6],
]);
const unitZ = (index: number) => 8 + (UNITS - 1 - index) * UNIT_H;

benchPlate(s, PLATE);
s.dots(dotGrid(PLATE.x + 18, PLATE.y + 18, 7, 4, 22, 0, s.P), {
	size: 0.5,
	tone: "faint",
});
// Main cabinet on its plinth.
s.halo(CAB, 0, 7);
s.solid(slabOf(insetPlan(CAB, -2), 0, 5, s.P, 3, 0.6), { tone: "lo" });
s.solid(slabOf(CAB, 5, CAB_H - 5, s.P, 3, 1));
screws(s, corners(CAB, 4), CAB_H, 1.3);
const face = CAB.y + CAB.d;
s.line(faceRect(s, "y", face, CAB.x + 3, CAB.x + CAB.w - 3, 6, CAB_H - 4), {
	tone: "mid",
});
for (let i = 0; i < UNITS; i++) {
	if (i === PULLED) {
		continue;
	}
	const z = unitZ(i);
	const h = UNIT_H - 1.6;
	s.line(faceRect(s, "y", face, CAB.x + 6, CAB.x + CAB.w - 6, z, z + h));
	faceRules(s, "y", face, CAB.x + 10, z + h / 2, [16], 0);
	s.dots(
		[0, 1, 2].map((k) => s.at([CAB.x + CAB.w - 11 - k * 4, face, z + h / 2])),
		{ size: 0.6, tone: i % 2 === 0 ? "hi" : "mid" }
	);
}
// Roof exhaust fan.
const fan: [number, number] = [CAB.x + CAB.w / 2, CAB.y + CAB.d / 2];
s.solid(cylinder(fan[0], fan[1], 16, CAB_H, 3, s.P, 40, 0.4), { tone: "lo" });
s.line(ring(fan[0], fan[1], 13, CAB_H + 3, s.P, 40), { tone: "mid" });
for (let k = 0; k < 5; k++) {
	const angle = (Math.PI * 2 * k) / 5;
	s.line(
		lineOnTop(
			[fan[0] + Math.cos(angle) * 3, fan[1] + Math.sin(angle) * 3],
			[
				fan[0] + Math.cos(angle + 0.5) * 12,
				fan[1] + Math.sin(angle + 0.5) * 12,
			],
			CAB_H + 3,
			s.P
		),
		{ tone: "lo" }
	);
}
s.solid(cylinder(fan[0], fan[1], 3, CAB_H + 3, 2, s.P, 20));
// The pulled unit on its slide rails.
const z = unitZ(PULLED);
const unit = { x: CAB.x + 6, y: face, w: CAB.w - 12, d: PULL, r: 1 };
s.line(
	faceRect(s, "y", face, unit.x - 1, unit.x + unit.w + 1, z - 1, z + UNIT_H),
	{
		tone: "mid",
	}
);
for (const x of [unit.x - 1.6, unit.x + unit.w]) {
	s.solid(
		slabOf({ x, y: unit.y, w: 1.6, d: unit.d, r: 0.3 }, z + 1, 2, s.P, 2),
		{ tone: "lo", crease: "none" }
	);
}
s.solid(slabOf(unit, z, UNIT_H - 1.6, s.P, 3, 0.4), { lit: true });
s.dots(dotGrid(unit.x + 6, unit.y + 4, 5, 2, 7, z + UNIT_H - 1.6, s.P), {
	size: 0.45,
	tone: "lo",
});
// Network switch cabinet beside it, patch lamps on top.
s.halo(SIDE, 0, 7);
s.solid(slabOf(insetPlan(SIDE, -2), 0, 5, s.P, 3, 0.6), { tone: "lo" });
s.solid(slabOf(SIDE, 5, SIDE_H - 5, s.P, 3, 1));
const sideFace = SIDE.y + SIDE.d;
for (const zz of [9, 19]) {
	s.line(
		faceRect(s, "y", sideFace, SIDE.x + 5, SIDE.x + SIDE.w - 5, zz, zz + 8)
	);
	faceRules(s, "y", sideFace, SIDE.x + 9, zz + 4, [14], 0);
}
for (const [x, y] of [
	[SIDE.x + 10, SIDE.y + 12],
	[SIDE.x + 20, SIDE.y + 12],
	[SIDE.x + 30, SIDE.y + 12],
] as const) {
	lamp(s, [x, y], SIDE_H, { radius: 1.6 });
}
screws(s, corners(SIDE, 5).slice(2), SIDE_H, 1.2);

export const drawing = cardDrawing(s);
