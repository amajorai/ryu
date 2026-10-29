import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRules, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Gateway rules apply: the node's only outlet is a conduit that runs through
 * an inline valve housing (the Gateway) before it reaches the terminal. The
 * housing's lit lamp marks where every model and tool call is checked.
 */

const PLATE = { x: -104, y: -44, w: 208, d: 88, r: 8 };
const NODE = { x: -94, y: -28, w: 46, d: 50, r: 4 };
const NODE_H = 34;
const PIPE_Z = 12;
const PIPE_H = 8;
const VALVE: [number, number] = [22, 0];
const VALVE_R = 17;
const VALVE_H = 30;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[VALVE[0], VALVE[1], VALVE_H + 12],
]);

function conduit(from: number, to: number) {
	// Saddles carry the conduit, so it never hangs in the air.
	for (const x of [from + 8, to - 8]) {
		s.solid(slabOf({ x: x - 3, y: -6, w: 6, d: 12, r: 1 }, 0, PIPE_Z, s.P, 2), {
			tone: "lo",
		});
	}
	s.solid(
		slabOf(
			{ x: from, y: -4, w: to - from, d: 8, r: 3 },
			PIPE_Z,
			PIPE_H,
			s.P,
			4,
			0.4
		)
	);
}

benchPlate(s, PLATE);
// The node cabinet at the back, vents on its faces.
s.halo(NODE, 0);
s.solid(slabOf(NODE, 0, NODE_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(NODE, 4), NODE_H, s.P, 3), { tone: "faint" });
faceRules(s, "y", NODE.y + NODE.d, NODE.x + 8, NODE_H - 8, [28, 28, 28, 28], 4);
lamp(s, [NODE.x + 12, NODE.y + 12], NODE_H, { radius: 1.8 });
conduit(NODE.x + NODE.w, VALVE[0] - VALVE_R + 2);
// The valve housing: flange, body, cap and handwheel.
s.halo({ x: VALVE[0] - 22, y: -22, w: 44, d: 44, r: 22 }, 0);
s.solid(cylinder(VALVE[0], VALVE[1], VALVE_R + 4, 0, 4, s.P, 40), {
	tone: "lo",
});
s.solid(cylinder(VALVE[0], VALVE[1], VALVE_R, 4, VALVE_H - 8, s.P, 40, 0.6));
s.solid(cylinder(VALVE[0], VALVE[1], VALVE_R + 2, VALVE_H - 4, 4, s.P, 40), {
	tone: "lo",
});
const capTop = VALVE_H;
screws(
	s,
	[
		[VALVE[0] - 12, VALVE[1] - 6],
		[VALVE[0] + 12, VALVE[1] + 6],
	],
	capTop,
	1.2
);
lamp(s, [VALVE[0] + 9, VALVE[1] - 10], capTop, { lit: true, radius: 2.8 });
s.solid(cylinder(VALVE[0], VALVE[1], 3, capTop, 6, s.P, 20), { tone: "lo" });
s.solid(cylinder(VALVE[0], VALVE[1], 12, capTop + 6, 3, s.P, 40));
s.line(knurl(VALVE[0], VALVE[1], 12, capTop + 6, capTop + 9, 32, s.P), {
	tone: "lo",
});
s.line(ring(VALVE[0], VALVE[1], 8, capTop + 9, s.P, 32), { tone: "faint" });
for (const [dx, dy] of [
	[8, 0],
	[-8, 0],
	[0, 8],
	[0, -8],
] as const) {
	s.line(lineOnTop(VALVE, [VALVE[0] + dx, VALVE[1] + dy], capTop + 9, s.P), {
		tone: "mid",
	});
}
s.solid(cylinder(VALVE[0], VALVE[1], 3, capTop + 9, 2, s.P, 20), {
	tone: "lo",
});
conduit(VALVE[0] + VALVE_R - 2, 76);
// The terminal block where calls leave for models and tools.
const term = { x: 76, y: -16, w: 20, d: 32, r: 3 };
s.halo(term, 0);
s.solid(slabOf(term, 0, 24, s.P, 4, 0.6));
screws(
	s,
	[
		[term.x + 10, term.y + 8],
		[term.x + 10, term.y + 24],
	],
	24,
	1.6
);

export const drawing = cardDrawing(s);
