import { boxCorners, slabOf, topTicks } from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";
import { sheetStack } from "./paper.ts";

/*
 * Chronology building: a timeline rail. Event cards stand in clips along a
 * graduated rail, in date order, and each one is tied by a thread back to
 * the source document it came from in the row of files behind. The newest
 * card has just been clipped in (the lit card).
 */

const PLATE = { x: -104, y: -50, w: 208, d: 100, r: 8 };
const RAIL = { x: -92, y: 16, w: 184, d: 16, r: 3 };
const RAIL_H = 6;
const CARD_H = 22;
const STOPS = [-64, -22, 20, 62];
const SOURCES = [-58, 0, 58];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, 40]]);

benchPlate(s, PLATE);
// The source files, back row.
const sourceTops = SOURCES.map((x) => {
	const plan = { x: x - 16, y: -44, w: 32, d: 22, r: 1 };
	s.halo(plan, 0);
	return sheetStack(s, plan, 0, 3, { thick: 2, shift: 1 });
});
// Threads from each event card back to its source.
STOPS.forEach((x, i) => {
	const source = Math.min(SOURCES.length - 1, Math.round((i * 2) / 3));
	const sx = SOURCES[source] ?? 0;
	s.wire(
		[sx, -33, sourceTops[source] ?? 8],
		[x, RAIL.y + 7, RAIL_H + CARD_H],
		[],
		{
			tone: "lo",
		}
	);
});
// The graduated rail.
s.halo(RAIL, 0);
s.solid(slabOf(RAIL, 0, RAIL_H, s.P, 4, 0.6));
const ticks = topTicks(
	RAIL.x + 6,
	RAIL.x + RAIL.w - 6,
	6,
	6,
	RAIL.y + RAIL.d - 1.5,
	RAIL_H,
	[2.5, 4.5],
	s.P
);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
screws(
	s,
	[
		[RAIL.x + 5, RAIL.y + 5],
		[RAIL.x + RAIL.w - 5, RAIL.y + 5],
	],
	RAIL_H,
	1.3
);
// Event cards, each in a clip on the rail.
STOPS.forEach((x, i) => {
	const lit = i === STOPS.length - 1;
	const clip = { x: x - 6, y: RAIL.y + 3, w: 12, d: 8, r: 1.5 };
	s.solid(slabOf(clip, RAIL_H, 5, s.P, 3, 0.4), { tone: "lo" });
	const card = { x: x - 17, y: RAIL.y + 6, w: 34, d: 2, r: 0.5 };
	s.solid(slabOf(card, RAIL_H + 2, CARD_H, s.P, 2), { lit, crease: "none" });
	faceRules(
		s,
		"y",
		card.y + card.d,
		card.x + 4,
		RAIL_H + CARD_H - 6,
		[22, 16, 19],
		5
	);
});

export const drawing = cardDrawing(s);
