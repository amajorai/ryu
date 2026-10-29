import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Literature screening: a paper sorter. A stack of papers waits in the feed
 * tray; the screening station checks each against its criteria and drops it
 * in the deep skip bin or, if it is worth a full read, in the front tray (the
 * lit sheet).
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const FEED = { x: -90, y: -44, w: 44, d: 36, r: 3 };
const STATION = { x: -24, y: -18, w: 44, d: 44, r: 4 };
const STATION_H = 26;
const BIN = { x: 30, y: -46, w: 48, d: 36, r: 3 };
const BIN_H = 15;
const TRAY = { x: 30, y: 4, w: 52, d: 40, r: 3 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 4, 36]]);

function sheet(plan: typeof FEED, z: number, lit = false) {
	s.solid(slabOf(plan, z, 1.6, s.P, 2), { lit, crease: "none" });
}

benchPlate(s, PLATE);
// Feed tray with the unscreened stack.
s.halo(FEED, 0);
s.solid(slabOf(FEED, 0, 4, s.P, 4, 0.6), { tone: "lo" });
const paper = insetPlan(FEED, 5);
for (let i = 0; i < 6; i++) {
	sheet(
		{ ...paper, x: paper.x + (i % 2) * 1.5, y: paper.y - (i % 3) },
		4 + i * 2.2
	);
}
// Screening station: a console with a slot on top, a criteria knob and lamp.
s.halo(STATION, 0);
s.solid(slabOf(STATION, 0, STATION_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(STATION, 5), STATION_H, s.P, 4), {
	tone: "faint",
});
s.line(
	planOutline(
		{ x: STATION.x + 8, y: STATION.y + 8, w: 28, d: 4, r: 1 },
		STATION_H,
		s.P,
		2
	),
	{ tone: "mid" }
);
knob(s, [STATION.x + 14, STATION.y + 28], STATION_H, 5, 5);
lamp(s, [STATION.x + 32, STATION.y + 30], STATION_H, { radius: 2 });
screws(
	s,
	[
		[STATION.x + 5, STATION.y + 5],
		[STATION.x + STATION.w - 5, STATION.y + STATION.d - 5],
	],
	STATION_H,
	1.3
);
// Skip bin at the back: an open box (floor, walls far to near) holding the
// rejected papers.
const WALL = 3;
s.halo(BIN, 0);
s.solid(slabOf(BIN, 0, 3, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf({ ...BIN, d: WALL, r: 1 }, 3, BIN_H - 3, s.P, 2), {
	tone: "lo",
});
s.solid(slabOf({ ...BIN, w: WALL, r: 1 }, 3, BIN_H - 3, s.P, 2), {
	tone: "lo",
});
const reject = insetPlan(BIN, 7);
for (let i = 0; i < 3; i++) {
	sheet(
		{ ...reject, x: reject.x + (i % 2) * 2, y: reject.y + i * 1.5 },
		3 + i * 2
	);
}
s.solid(
	slabOf(
		{ ...BIN, x: BIN.x + BIN.w - WALL, w: WALL, r: 1 },
		3,
		BIN_H - 3,
		s.P,
		2
	),
	{ tone: "lo" }
);
s.solid(
	slabOf(
		{ ...BIN, y: BIN.y + BIN.d - WALL, d: WALL, r: 1 },
		3,
		BIN_H - 3,
		s.P,
		2
	),
	{ tone: "lo" }
);
// Full-read tray at the front: a shallow tray, one paper in it.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 5, s.P, 4, 0.6));
s.line(planOutline(insetPlan(TRAY, 3), 5, s.P, 2), { tone: "lo" });
sheet(insetPlan(TRAY, 7), 5, true);

export const drawing = cardDrawing(s);
