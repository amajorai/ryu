import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Onboarding tracking: a milestone track. A new account's puck slides along
 * the slot past a row of milestone posts; the steps behind it have their pegs
 * pushed down. It has stalled at the third post, which is lit: time for the
 * next nudge.
 */

const PLATE = { x: -100, y: -48, w: 200, d: 96, r: 8 };
const TRACK = { x: -88, y: -10, w: 176, d: 30, r: 4 };
const TRACK_H = 8;
const SLOT_Y = TRACK.y + 18;
const STOPS = [-66, -32, 2, 36, 70];
const STALLED = 2;
const POST_Y = -26;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [70, POST_Y, 32]]);

function post(x: number, index: number) {
	const height = 18 + index * 2;
	const plan = { x: x - 6, y: POST_Y - 6, w: 12, d: 12, r: 2 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, height, s.P, 3, 0.6), { lit: index === STALLED });
	lamp(s, [x, POST_Y], height, { radius: 3 });
}

benchPlate(s, PLATE);
for (const [index, x] of STOPS.entries()) {
	post(x, index);
}
s.halo(TRACK, 0);
s.solid(slabOf(TRACK, 0, TRACK_H, s.P, 4, 0.8));
s.line(planOutline(insetPlan(TRACK, 3), TRACK_H, s.P, 2), { tone: "faint" });
// The slot the puck runs in.
s.solid(
	slabOf(
		{ x: TRACK.x + 8, y: SLOT_Y - 2, w: TRACK.w - 16, d: 4, r: 2 },
		TRACK_H - 0.4,
		0.4,
		s.P,
		3
	),
	{ tone: "lo", crease: "none" }
);
// Pegs by each milestone: pushed flush once that step is done.
for (const [index, x] of STOPS.entries()) {
	const done = index < STALLED;
	s.line(lineOnTop([x, TRACK.y + 2], [x, TRACK.y + 8], TRACK_H, s.P), {
		tone: "lo",
	});
	s.solid(cylinder(x + 8, TRACK.y + 6, 2.2, TRACK_H, done ? 0.6 : 4, s.P, 16), {
		tone: done ? "lo" : "hi",
	});
}
// The account's puck, stopped at the stalled milestone.
const puck: [number, number] = [STOPS[STALLED] ?? 0, SLOT_Y];
s.solid(cylinder(puck[0], puck[1], 2, TRACK_H, 2, s.P, 16), { tone: "lo" });
s.solid(cylinder(puck[0], puck[1], 8, TRACK_H + 2, 6, s.P, 36, 0.8));
s.line(knurl(puck[0], puck[1], 8, TRACK_H + 3, TRACK_H + 7, 30, s.P), {
	tone: "lo",
});
// End stop at the finish.
s.solid(
	slabOf(
		{ x: TRACK.x + TRACK.w - 6, y: SLOT_Y - 6, w: 4, d: 12, r: 1 },
		TRACK_H,
		6,
		s.P,
		2
	),
	{ tone: "lo" }
);

export const drawing = cardDrawing(s);
