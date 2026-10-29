import {
	boxCorners,
	cylinder,
	knurl,
	slabOf,
	topTicks,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Variance analysis: two bars squared against one stop, the budget bar and
 * the longer actuals bar. A caliper in front spans only the length the
 * actuals run past the budget (the lit end): the swing to explain. The slip
 * tray at the front holds the transactions it was measured from.
 */

const PLATE = { x: -102, y: -56, w: 204, d: 112, r: 8 };
const STOP = { x: -90, y: -46, w: 8, d: 46, r: 1.5 };
const BAR_H = 10;
const BUDGET = { x: -82, y: -42, w: 92, d: 16, r: 1.5 };
const ACTUAL = { x: -82, y: -20, w: 92, d: 16, r: 1.5 };
const SWING = { x: 10, y: -20, w: 32, d: 16, r: 1.5 };
const JAW_A = 10;
const JAW_B = 42;
const BEAM = { x: -54, y: 18, w: 132, d: 8, r: 1 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, -40, 18]]);

benchPlate(s, PLATE);
s.halo(STOP, 0);
s.solid(slabOf(STOP, 0, 16, s.P, 3, 0.4), { tone: "lo" });
s.halo(BUDGET, 0);
s.solid(slabOf(BUDGET, 0, BAR_H, s.P, 3, 0.6));
s.halo({ ...ACTUAL, w: ACTUAL.w + SWING.w }, 0);
s.solid(slabOf(ACTUAL, 0, BAR_H, s.P, 3, 0.6));
s.solid(slabOf(SWING, 0, BAR_H, s.P, 3, 0.6), { lit: true });
// The caliper: beam with a scale, fixed jaw and sliding jaw with thumbwheel.
s.halo(BEAM, 0);
s.solid(slabOf(BEAM, 0, 4, s.P, 2, 0.4));
const ticks = topTicks(
	BEAM.x + 22,
	BEAM.x + BEAM.w - 4,
	3,
	5,
	BEAM.y + 0.8,
	4,
	[2, 3.6],
	s.P
);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
for (const x of [JAW_A, JAW_B]) {
	s.solid(
		slabOf(
			{ x: x - (x === JAW_A ? 4 : 0), y: -4, w: 4, d: 22, r: 0.6 },
			0,
			6,
			s.P,
			2
		),
		{
			tone: "lo",
		}
	);
}
s.solid(
	slabOf({ x: JAW_A - 14, y: 14, w: 14, d: 16, r: 1.5 }, 0, 7, s.P, 3, 0.4)
);
screws(s, [[JAW_A - 7, 22]], 7, 1.4);
s.solid(slabOf({ x: JAW_B, y: 14, w: 16, d: 16, r: 1.5 }, 0, 7, s.P, 3, 0.4));
s.solid(cylinder(JAW_B + 8, 34, 4, 0, 5, s.P, 24), { tone: "lo" });
s.line(knurl(JAW_B + 8, 34, 4, 0, 5, 20, s.P), { tone: "faint" });
// Slips of the underlying transactions.
const tray = { x: -90, y: 28, w: 46, d: 24, r: 3 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 4, s.P, 4, 0.6), { tone: "lo" });
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf(
			{ x: tray.x + 4 + i * 2, y: tray.y + 4, w: 32, d: 16, r: 1 },
			4 + i * 1.2,
			1.2,
			s.P,
			2
		),
		{ crease: "none" }
	);
}

export const drawing = cardDrawing(s);
