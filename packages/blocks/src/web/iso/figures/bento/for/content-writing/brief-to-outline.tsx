import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Brief to outline: a sorting rack. The one-line brief (the lit strip) drops
 * into the feed block; out of it comes a rack of divider cards, one per
 * section, their tabs stepped like an outline, waiting at the approve lever.
 */

const PLATE = { x: -96, y: -48, w: 192, d: 96, r: 8 };
const FEED = { x: -84, y: -24, w: 32, d: 42, r: 4 };
const FEED_H = 22;
const RACK = { x: -40, y: -34, w: 120, d: 62, r: 4 };
const RACK_H = 6;
const DIVIDER_H = 26;
// x of each divider, back to front, and where along y its tab sits.
const DIVIDERS: [number, number][] = [
	[-30, -28],
	[-12, -16],
	[6, -4],
	[24, 8],
	[42, -16],
	[60, -4],
];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[FEED.x + 16, FEED.y + 10, FEED_H + 16],
	[-30, -28, RACK_H + DIVIDER_H + 6],
]);

benchPlate(s, PLATE);
// Feed block with a slot on top; the brief strip stands in it.
s.halo(FEED, 0);
s.solid(slabOf(FEED, 0, FEED_H, s.P, 4, 1));
const slot = { x: FEED.x + 14, y: FEED.y + 6, w: 4, d: 26, r: 1 };
s.line(planOutline(slot, FEED_H, s.P, 2), { tone: "mid" });
s.solid(
	slabOf(
		{ x: slot.x + 1, y: slot.y + 3, w: 2, d: 20, r: 0.4 },
		FEED_H,
		14,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
lamp(s, [FEED.x + 7, FEED.y + FEED.d - 7], FEED_H, { radius: 1.8 });
// The rack: a tray with divider cards standing across it, tabs stepped.
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 4, 0.8), { tone: "lo" });
s.line(planOutline(insetPlan(RACK, 4), RACK_H, s.P, 3), { tone: "faint" });
for (const [x, tab] of DIVIDERS) {
	s.solid(
		slabOf(
			{ x, y: RACK.y + 6, w: 2, d: RACK.d - 14, r: 0.4 },
			RACK_H,
			DIVIDER_H,
			s.P,
			2
		),
		{ crease: "none" }
	);
	s.solid(
		slabOf({ x, y: tab, w: 2, d: 12, r: 0.4 }, RACK_H + DIVIDER_H, 5, s.P, 2),
		{ crease: "none" }
	);
}
screws(
	s,
	[
		[RACK.x + 5, RACK.y + RACK.d - 4],
		[RACK.x + RACK.w - 5, RACK.y + 5],
	],
	RACK_H,
	1.2
);
// The approve lever on the front of the rack.
knob(s, [RACK.x + RACK.w - 10, RACK.y + RACK.d + 8], 0, 4, 6);

export const drawing = cardDrawing(s);
