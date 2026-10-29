import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	faceRules,
	knob,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Output to you: a pneumatic tube station. The job machine at the back sends
 * its result up one sealed tube, and the tube runs to a single keyed receiver
 * in front; the capsule lands in that receiver's cup (the lit capsule) and
 * nowhere else.
 */

const PLATE = { x: -84, y: -46, w: 168, d: 94, r: 8 };
const MACHINE = { x: -72, y: -36, w: 52, d: 44, r: 4 };
const MACHINE_H = 30;
const RECEIVER = { x: 18, y: -8, w: 46, d: 36, r: 4 };
const RECEIVER_H = 26;
const TUBE_TOP = 48;
const PIPE = 3;
const SEND: [number, number] = [-46, -14];
const TAKE: [number, number] = [41, 8];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[SEND[0], SEND[1], TUBE_TOP + 4],
	[TAKE[0], TAKE[1], TUBE_TOP + 4],
]);

function riser([x, y]: [number, number], from: number) {
	s.solid(cylinder(x, y, 8, from, 2, s.P, 24), { tone: "lo" });
	s.solid(cylinder(x, y, 5, from + 2, TUBE_TOP - from - 2, s.P, 24));
	s.line(ring(x, y, 5, from + 12, s.P, 24), { tone: "faint" });
}

function head([x, y]: [number, number]) {
	s.solid(cylinder(x, y, 6.5, TUBE_TOP, 5, s.P, 24, 0.4), { tone: "lo" });
}

benchPlate(s, PLATE);
// The job machine and its send tube.
s.halo(MACHINE, 0);
s.solid(slabOf(MACHINE, 0, MACHINE_H, s.P, 6, 1));
s.line(planOutline(insetPlan(MACHINE, 5), MACHINE_H, s.P, 6), {
	tone: "faint",
});
faceRules(
	s,
	"y",
	MACHINE.y + MACHINE.d,
	MACHINE.x + 8,
	MACHINE_H - 8,
	[32, 32, 32, 32],
	5
);
lamp(s, [MACHINE.x + 10, MACHINE.y + 10], MACHINE_H, { radius: 1.8 });
riser(SEND, MACHINE_H);
// The keyed receiver and its tube.
s.halo(RECEIVER, 0);
s.solid(slabOf(RECEIVER, 0, RECEIVER_H, s.P, 6, 1));
screws(
	s,
	[
		[RECEIVER.x + 8, RECEIVER.y + 8],
		[RECEIVER.x + RECEIVER.w - 8, RECEIVER.y + RECEIVER.d - 8],
	],
	RECEIVER_H,
	1.4
);
knob(s, [RECEIVER.x + 10, RECEIVER.y + RECEIVER.d - 9], RECEIVER_H, 3.5, 4);
riser(TAKE, RECEIVER_H);
// The overhead run: along x from the send head, then along y to the receiver.
s.solid(
	slabOf(
		{ x: SEND[0], y: SEND[1] - PIPE, w: TAKE[0] - SEND[0], d: PIPE * 2, r: 2 },
		TUBE_TOP + 0.5,
		PIPE * 2 - 2,
		s.P,
		3
	)
);
s.solid(cylinder(TAKE[0], SEND[1], 5, TUBE_TOP, 5, s.P, 20, 0.4), {
	tone: "lo",
});
s.solid(
	slabOf(
		{ x: TAKE[0] - PIPE, y: SEND[1], w: PIPE * 2, d: TAKE[1] - SEND[1], r: 2 },
		TUBE_TOP + 0.5,
		PIPE * 2 - 2,
		s.P,
		3
	)
);
head(SEND);
head(TAKE);
const front = RECEIVER.y + RECEIVER.d;
s.line(faceRect(s, "y", front, RECEIVER.x + 10, RECEIVER.x + 36, 7, 20), {
	tone: "mid",
});
// The cup in front of the receiver door, with the capsule in it.
const cup = { x: RECEIVER.x + 8, y: front, w: 30, d: 16, r: 3 };
s.halo(cup, 0);
s.solid(slabOf(cup, 0, 4, s.P, 4, 0.6), { tone: "lo" });
s.solid(cylinder(cup.x + 15, cup.y + 8, 5.5, 4, 11, s.P, 24, 0.6), {
	lit: true,
});

export const drawing = cardDrawing(s);
