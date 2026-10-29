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
	faceRules,
	jack,
	knob,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Risky actions ask: an outbox tray of outgoing letters (send, post, merge)
 * held behind a latched gate. Nothing leaves until you press the approval
 * button on the console beside it (the lit part), which trips the latch.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const TRAY = { x: -82, y: -36, w: 70, d: 60, r: 2 };
const WALL = 4;
const WALL_H = 16;
const GATE_H = 26;
const CONSOLE = { x: 6, y: -30, w: 70, d: 54, r: 5 };
const CONSOLE_H = 16;
const BUTTON: [number, number] = [38, -2];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[TRAY.x + TRAY.w, 0, GATE_H + 9],
]);

benchPlate(s, PLATE);
// Outbox tray: back and left walls, floor, the held letters, then the gate.
s.halo(TRAY, 0);
s.solid(slabOf({ ...TRAY, d: WALL, r: 1 }, 0, WALL_H, s.P, 2, 0.4));
s.solid(slabOf({ ...TRAY, w: WALL, r: 1 }, 0, WALL_H, s.P, 2, 0.4));
s.solid(slabOf(insetPlan(TRAY, 0.5), 0, 3, s.P, 2, 0.4), { tone: "lo" });
for (let i = 0; i < 4; i++) {
	s.solid(
		slabOf(
			{ x: TRAY.x + 10 + i * 2, y: TRAY.y + 10 - i * 1.5, w: 40, d: 30, r: 1 },
			3 + i * 3,
			2.4,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
s.line(
	planOutline(
		{ x: TRAY.x + 22, y: TRAY.y + 16, w: 20, d: 12, r: 1 },
		3 + 3 * 3 + 2.4,
		s.P,
		2
	),
	{ tone: "faint" }
);
// Gate on the outlet side, taller than the walls, with its latch on top.
const gate = { x: TRAY.x + TRAY.w - WALL, y: TRAY.y, w: WALL, d: TRAY.d, r: 1 };
s.solid(slabOf(gate, 0, GATE_H, s.P, 2, 0.4));
// Latch: a catch block clamped over the gate top, its bolt pin standing up.
s.solid(
	slabOf({ x: gate.x - 3, y: -16, w: 10, d: 16, r: 1.5 }, GATE_H, 5, s.P, 2),
	{
		tone: "lo",
	}
);
s.solid(cylinder(gate.x + 2, -8, 2.4, GATE_H + 5, 3, s.P, 20));
s.solid(
	slabOf(
		{ ...TRAY, y: TRAY.y + TRAY.d - WALL, w: TRAY.w - WALL, d: WALL, r: 1 },
		0,
		WALL_H,
		s.P,
		2,
		0.4
	)
);
// Approval console.
s.halo(CONSOLE, 0);
s.solid(slabOf(CONSOLE, 0, CONSOLE_H, s.P, 6, 1));
s.line(planOutline(insetPlan(CONSOLE, 5), CONSOLE_H, s.P, 4), {
	tone: "faint",
});
// Release cable from the latch, landing in a jack on the console top.
jack(s, [CONSOLE.x + 10, -8], CONSOLE_H);
s.wire(
	[gate.x + WALL + 3, -8, GATE_H + 2.5],
	[CONSOLE.x + 10, -8, CONSOLE_H],
	[[CONSOLE.x + 10, -8, GATE_H + 2.5]]
);
screws(
	s,
	[
		[CONSOLE.x + 9, CONSOLE.y + 9],
		[CONSOLE.x + CONSOLE.w - 9, CONSOLE.y + CONSOLE.d - 9],
	],
	CONSOLE_H,
	1.6
);
lamp(s, [CONSOLE.x + 10, CONSOLE.y + 38], CONSOLE_H, { radius: 1.8 });
lamp(s, [CONSOLE.x + 10, CONSOLE.y + 46], CONSOLE_H, { radius: 1.8 });
s.solid(cylinder(BUTTON[0], BUTTON[1], 14, CONSOLE_H, 2, s.P, 40), {
	tone: "lo",
});
s.line(ring(BUTTON[0], BUTTON[1], 12, CONSOLE_H + 2, s.P, 40), { tone: "mid" });
s.solid(cylinder(BUTTON[0], BUTTON[1], 10, CONSOLE_H + 2, 6, s.P, 40, 1), {
	lit: true,
});
knob(s, [CONSOLE.x + CONSOLE.w - 12, CONSOLE.y + 14], CONSOLE_H, 4, 4);
faceRules(s, "y", CONSOLE.y + CONSOLE.d, CONSOLE.x + 10, 11, [34, 24], 4);

export const drawing = cardDrawing(s);
