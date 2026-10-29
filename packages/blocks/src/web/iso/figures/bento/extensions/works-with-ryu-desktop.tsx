import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Works with Ryu Desktop: a desktop unit sitting on its docking base. The
 * plugin is a cartridge pushed into the base's bay (the lit card), so the
 * unit on top gains a feature while staying exactly as it was.
 */

const PLATE = { x: -92, y: -52, w: 184, d: 104, r: 8 };
const DOCK = { x: -76, y: -40, w: 148, d: 78, r: 5 };
const DOCK_H = 10;
const UNIT = { x: -66, y: -32, w: 74, d: 56, r: 4 };
const UNIT_H = 26;
const UNIT_TOP = DOCK_H + UNIT_H;
const BAY_X = [24, 40] as const;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, 0, UNIT_TOP + 4],
	[32, 0, DOCK_H + 26],
]);

benchPlate(s, PLATE);
// Docking base: the Core the plugins run in.
s.halo(DOCK, 0);
s.solid(slabOf(DOCK, 0, DOCK_H, s.P, 6, 1));
s.line(planOutline(insetPlan(DOCK, 4), DOCK_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[DOCK.x + DOCK.w - 8, DOCK.y + 8],
		[DOCK.x + DOCK.w - 8, DOCK.y + DOCK.d - 8],
	],
	DOCK_H,
	1.4
);
// The desktop unit, untouched: a screen well and a row of keys.
s.halo(UNIT, DOCK_H);
s.solid(slabOf(UNIT, DOCK_H, UNIT_H, s.P, 6, 1));
const screen = { x: UNIT.x + 7, y: UNIT.y + 6, w: UNIT.w - 14, d: 30, r: 2 };
s.solid(slabOf(screen, UNIT_TOP, 1, s.P, 3), { tone: "lo", crease: "none" });
for (const [i, span] of [40, 30, 34].entries()) {
	const y = screen.y + 8 + i * 7;
	s.line(
		lineOnTop([screen.x + 6, y], [screen.x + 6 + span, y], UNIT_TOP + 1, s.P),
		{ tone: i === 0 ? "mid" : "faint" }
	);
}
for (let i = 0; i < 5; i++) {
	const key = { x: UNIT.x + 8 + i * 12, y: UNIT.y + 42, w: 9, d: 7, r: 1 };
	s.solid(slabOf(key, UNIT_TOP, 1.6, s.P, 2, 0.3), { tone: "lo" });
}
// Cartridge bay on the dock: one slot taken, one free.
for (const x of BAY_X) {
	s.solid(slabOf({ x: x - 6, y: -24, w: 12, d: 44, r: 2 }, DOCK_H, 2, s.P, 3), {
		tone: "lo",
	});
	s.line(
		planOutline({ x: x - 2, y: -20, w: 4, d: 36, r: 1 }, DOCK_H + 2, s.P, 2),
		{
			tone: "mid",
		}
	);
}
s.solid(
	slabOf(
		{ x: BAY_X[0] - 1.6, y: -18, w: 3.2, d: 32, r: 0.6 },
		DOCK_H + 2,
		24,
		s.P,
		2
	),
	{ lit: true }
);
s.solid(
	slabOf(
		{ x: BAY_X[0] - 3, y: -16, w: 6, d: 8, r: 1 },
		DOCK_H + 26,
		1.6,
		s.P,
		2
	),
	{ tone: "lo" }
);
lamp(s, [58, -22], DOCK_H, { radius: 1.8 });
knob(s, [58, 22], DOCK_H, 5, 5);

export const drawing = cardDrawing(s);
