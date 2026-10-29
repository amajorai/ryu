import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	radialTicks,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRules,
	knob,
	lamp,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Recurring report generation: a timed print press. The cam timer at the
 * front sets the schedule; when its hand comes round, the press assembles the
 * report and stacks it in the out tray, newest copy on top (the lit sheet).
 */

const PLATE = { x: -104, y: -54, w: 208, d: 108, r: 8 };
const DIAL: [number, number] = [-70, 24];
const DIAL_R = 24;
const DIAL_H = 14;
const PRESS = { x: -38, y: -38, w: 64, d: 54, r: 4 };
const PRESS_H = 30;
const TRAY = { x: 36, y: -4, w: 52, d: 46, r: 3 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, -10, 40]]);

benchPlate(s, PLATE);
// Cam timer: a ticked drum with one hand.
s.halo({ x: DIAL[0] - DIAL_R, y: DIAL[1] - DIAL_R, w: 48, d: 48, r: 24 }, 0);
s.solid(cylinder(DIAL[0], DIAL[1], DIAL_R, 0, DIAL_H, s.P, 48, 0.8));
s.line(ring(DIAL[0], DIAL[1], DIAL_R - 3, DIAL_H, s.P, 48), { tone: "lo" });
const ticks = radialTicks(
	DIAL[0],
	DIAL[1],
	DIAL_R - 4,
	28,
	7,
	DIAL_H,
	[2, 4],
	s.P
);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
s.line(lineOnTop(DIAL, [DIAL[0] + 10, DIAL[1] - 9], DIAL_H + 1.5, s.P), {
	tone: "hi",
});
s.solid(cylinder(DIAL[0], DIAL[1], 3.5, DIAL_H, 3, s.P, 20), { tone: "lo" });
// The press body, with a feed slot, a pressure knob and a ready lamp.
s.halo(PRESS, 0);
s.solid(slabOf(PRESS, 0, PRESS_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(PRESS, 5), PRESS_H, s.P, 4), { tone: "faint" });
s.line(planOutline({ x: -30, y: -30, w: 40, d: 6, r: 1 }, PRESS_H, s.P, 2), {
	tone: "mid",
});
knob(s, [-20, 0], PRESS_H, 6, 6);
lamp(s, [12, 4], PRESS_H, { radius: 2 });
screws(
	s,
	[
		[PRESS.x + 6, PRESS.y + PRESS.d - 6],
		[PRESS.x + PRESS.w - 6, PRESS.y + PRESS.d - 6],
	],
	PRESS_H,
	1.4
);
faceRules(s, "y", PRESS.y + PRESS.d, PRESS.x + 10, 20, [36, 26], 5);
// Output chute from the press side down into the tray.
s.solid(slabOf({ x: 26, y: -2, w: 10, d: 16, r: 1 }, 0, 4, s.P, 2), {
	tone: "lo",
});
// Out tray with the stacked reports.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 5, s.P, 4, 0.6), { tone: "lo" });
const SHEET = insetPlan(TRAY, 6);
for (let i = 0; i < 4; i++) {
	const top = i === 3;
	s.solid(slabOf({ ...SHEET, x: SHEET.x + i * 0.8 }, 5 + i * 2, 2, s.P, 3), {
		lit: top,
		crease: "none",
	});
}
for (const [i, span] of [26, 20, 24, 14].entries()) {
	const y = SHEET.y + 8 + i * 7;
	s.line(lineOnTop([SHEET.x + 7, y], [SHEET.x + 7 + span, y], 13, s.P), {
		tone: "lo",
	});
}

export const drawing = cardDrawing(s);
