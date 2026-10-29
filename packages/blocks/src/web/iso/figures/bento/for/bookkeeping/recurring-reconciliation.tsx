import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	radialTicks,
	ring,
	segment,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Recurring reconciliation: a balance on a timer. The bank feed sits in one
 * pan and the ledger in the other, so a matched period hangs level. A clock
 * dial in the base sets when it weighs again; the one coin that matched
 * nothing waits in the review tray in front (the lit coin).
 */

const PLATE = { x: -96, y: -52, w: 192, d: 104, r: 8 };
const BEAM_Z = 58;
const PAN_Z = 20;
const PAN_X = 52;
const PAN_R = 18;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, BEAM_Z + 10]]);

/** A cord from the beam end down to one point on the pan's rim. */
function cord(x: number, [dx, dy]: readonly [number, number]) {
	s.line(segment([x, 0, BEAM_Z], [x + dx, dy, PAN_Z + 3], s.P), {
		tone: "mid",
	});
}

/** A pan hung from the beam end, with its stack of coins. */
function pan(x: number, coins: number) {
	s.solid(cylinder(x, 0, PAN_R, PAN_Z, 3, s.P, 40, 0.5));
	s.line(ring(x, 0, PAN_R - 3, PAN_Z + 3, s.P, 40), { tone: "lo" });
	// Far cords go behind the coins, the near one in front of them.
	cord(x, [-PAN_R + 2, 0]);
	cord(x, [0, -PAN_R + 2]);
	for (let i = 0; i < coins; i++) {
		s.solid(cylinder(x, 0, 8, PAN_Z + 3 + i * 3, 3, s.P, 28, 0.3), {
			tone: i === coins - 1 ? "mid" : "lo",
		});
	}
	cord(x, [PAN_R - 2, 0]);
}

benchPlate(s, PLATE);
pan(-PAN_X, 4);
// Column, pivot and beam.
const foot = { x: -16, y: -16, w: 32, d: 32, r: 4 };
s.halo(foot, 0);
s.solid(slabOf(foot, 0, 6, s.P, 4, 0.8));
screws(
	s,
	[
		[-10, 10],
		[10, -10],
	],
	6,
	1.2
);
s.solid(cylinder(0, 0, 4, 6, BEAM_Z - 8, s.P, 24));
s.solid(cylinder(0, 0, 6, BEAM_Z - 2, 4, s.P, 24), { tone: "lo" });
s.solid(
	slabOf(
		{ x: -PAN_X - 4, y: -3, w: PAN_X * 2 + 8, d: 6, r: 1 },
		BEAM_Z,
		3,
		s.P,
		2
	)
);
s.solid(slabOf({ x: -1.5, y: -2, w: 3, d: 4, r: 0.5 }, BEAM_Z + 3, 7, s.P, 2), {
	tone: "lo",
});
pan(PAN_X, 4);
// Schedule clock in front of the column.
const CLOCK: [number, number] = [-56, 32];
s.halo({ x: CLOCK[0] - 15, y: CLOCK[1] - 15, w: 30, d: 30, r: 15 }, 0);
s.solid(cylinder(CLOCK[0], CLOCK[1], 15, 0, 6, s.P, 40, 0.6));
const ticks = radialTicks(CLOCK[0], CLOCK[1], 13, 12, 3, 6, [2, 4], s.P);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
s.line(lineOnTop(CLOCK, [CLOCK[0] + 7, CLOCK[1] - 6], 6, s.P), { tone: "hi" });
s.solid(cylinder(CLOCK[0], CLOCK[1], 2, 6, 1.5, s.P, 16), { tone: "lo" });
// Review tray for what did not match.
const TRAY = { x: 2, y: 24, w: 38, d: 22, r: 3 };
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 5, s.P, 4, 0.6), { tone: "lo" });
s.line(planOutline(insetPlan(TRAY, 3), 5, s.P, 3), { tone: "faint" });
s.solid(cylinder(21, 35, 8, 5, 3, s.P, 28, 0.3), { lit: true });

export const drawing = cardDrawing(s);
