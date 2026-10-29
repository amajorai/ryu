import { boxCorners, slabOf } from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	knob,
	lamp,
	ruler,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Experiment design: a two-lane test track. Each lane carries one variant's
 * carriage from the start gate at the back; the ruler along the front is the
 * sample size, and the stop bar at the far end (the lit part) is the stop
 * rule both lanes run into.
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const LANE_X = -70;
const LANE_W = 130;
const LANE_H = 5;
const LANES = [-34, -2];
const STOP_X = LANE_X + LANE_W + 2;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, -40, 30]]);

function lane(y: number, carriageX: number) {
	const plan = { x: LANE_X, y, w: LANE_W, d: 22, r: 3 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, LANE_H, s.P, 4, 0.6));
	s.line(
		slabOf(
			{ x: LANE_X + 4, y: y + 10, w: LANE_W - 8, d: 2, r: 1 },
			LANE_H,
			0.1,
			s.P
		).fill,
		{ tone: "lo" }
	);
	screws(
		s,
		[
			[LANE_X + 6, y + 5],
			[LANE_X + LANE_W - 8, y + 17],
		],
		LANE_H,
		1.3
	);
	const carriage = { x: carriageX, y: y + 3, w: 26, d: 16, r: 2 };
	s.halo(carriage, LANE_H);
	s.solid(slabOf(carriage, LANE_H, 10, s.P, 4, 0.6));
	lamp(s, [carriageX + 19, y + 11], LANE_H + 10, { radius: 2 });
}

benchPlate(s, PLATE);
// Start gate at the back end of both lanes.
const gate = { x: LANE_X - 16, y: -36, w: 12, d: 58, r: 2 };
s.halo(gate, 0);
s.solid(slabOf(gate, 0, 18, s.P, 4, 0.8));
knob(s, [LANE_X - 10, -22], 18, 3.6, 4);
knob(s, [LANE_X - 10, 10], 18, 3.6, 4);
lane(LANES[0] ?? 0, -12);
lane(LANES[1] ?? 0, 14);
// The stop bar across the far ends of both lanes.
const stop = { x: STOP_X, y: -38, w: 12, d: 62, r: 2 };
s.halo(stop, 0);
s.solid(slabOf(stop, 0, 22, s.P, 4, 0.8), { lit: true });
ruler(s, { x: LANE_X, y: 30, w: LANE_W, d: 8, r: 1 });

export const drawing = cardDrawing(s);
