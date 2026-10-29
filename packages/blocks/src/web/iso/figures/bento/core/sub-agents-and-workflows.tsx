import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	radialTicks,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Sub-agents and workflows: an indexing turntable. The agent sits at the hub;
 * its arm hands the next step (the lit block) to one of the four stations
 * around it, each a sub-agent or workflow that Core runs on the same table.
 */

const PLATE = { x: -86, y: -70, w: 172, d: 140, r: 8 };
const R = 34;
const REACH = 60;
const TABLE_Z = 8;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, 34]]);

function station(x: number, y: number) {
	const plan = { x: x - 12, y: y - 12, w: 24, d: 24, r: 3 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, 16, s.P, 4, 0.8));
	s.line(planOutline(insetPlan(plan, 3.5), 16, s.P, 3), { tone: "faint" });
	lamp(s, [x, y], 16, { radius: 2 });
}

benchPlate(s, PLATE);
station(-REACH, 0);
station(0, -54);
// The turntable: a base collar, the indexed disc and the agent's hub.
s.halo({ x: -R - 4, y: -R - 4, w: 2 * R + 8, d: 2 * R + 8, r: R + 4 }, 0);
s.solid(cylinder(0, 0, R + 4, 0, 3, s.P, 64), { tone: "lo" });
s.solid(cylinder(0, 0, R, 3, TABLE_Z - 3, s.P, 64, 0.8));
const ticks = radialTicks(0, 0, R - 2, 24, 6, TABLE_Z, [2.5, 5], s.P);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
s.line(ring(0, 0, R - 10, TABLE_Z, s.P, 48), { tone: "faint" });
// The arm reaches out to the station in front, carrying the step.
s.solid(slabOf({ x: 0, y: -4, w: 46, d: 8, r: 2 }, TABLE_Z, 4, s.P, 3, 0.4));
s.solid(cylinder(0, 0, 9, TABLE_Z, 14, s.P, 32, 0.6));
knob(s, [0, 0], TABLE_Z + 14, 5, 5);
const step = { x: 33, y: -6, w: 12, d: 12, r: 2 };
s.halo(step, TABLE_Z + 4);
s.solid(slabOf(step, TABLE_Z + 4, 9, s.P, 3, 0.4), { lit: true });
station(0, 54);
station(REACH, 0);
screws(
	s,
	[
		[-70, 54],
		[70, -54],
	],
	0,
	1.6
);

export const drawing = cardDrawing(s);
