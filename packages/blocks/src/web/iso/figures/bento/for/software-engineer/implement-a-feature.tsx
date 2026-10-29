import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	knob,
	lamp,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Implement a feature: a small press. Tickets wait in the hopper at the back;
 * the press turns one into a finished part, which lands on a two-lane review
 * tray in front: one lane to apply, one to send off as a PR. The new part
 * (the lit block) sits on the tray waiting for the call.
 */

const PLATE = { x: -100, y: -52, w: 200, d: 104, r: 8 };
const HOPPER = { x: -88, y: -40, w: 40, d: 34, r: 3 };
const PRESS = { x: -38, y: -38, w: 54, d: 46, r: 4 };
const PRESS_H = 30;
const TRAY = { x: 26, y: -12, w: 62, d: 52, r: 4 };
const TRAY_H = 4;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[PRESS.x, PRESS.y, PRESS_H + 10],
]);

benchPlate(s, PLATE);
// Ticket hopper: a shallow tray with a short stack of cards.
s.halo(HOPPER, 0);
s.solid(slabOf(HOPPER, 0, 6, s.P, 4, 0.6), { tone: "lo" });
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf(
			{ x: HOPPER.x + 6, y: HOPPER.y + 6, w: 28, d: 22, r: 1 },
			6 + i * 2.4,
			2,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
// The press body with its slot, a handle and a status lamp.
s.halo(PRESS, 0);
s.solid(slabOf(PRESS, 0, PRESS_H, s.P, 6, 1));
s.line(planOutline(insetPlan(PRESS, 5), PRESS_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[PRESS.x + 8, PRESS.y + 8],
		[PRESS.x + PRESS.w - 8, PRESS.y + PRESS.d - 8],
	],
	PRESS_H,
	1.6
);
s.line(
	faceRect(
		s,
		"y",
		PRESS.y + PRESS.d,
		PRESS.x + 10,
		PRESS.x + PRESS.w - 10,
		6,
		11
	),
	{ tone: "lo" }
);
s.line(
	faceRect(
		s,
		"x",
		PRESS.x + PRESS.w,
		PRESS.y + 10,
		PRESS.y + PRESS.d - 10,
		16,
		24
	),
	{ tone: "faint" }
);
lamp(s, [PRESS.x + PRESS.w - 10, PRESS.y + 10], PRESS_H, { radius: 1.8 });
knob(s, [PRESS.x + 18, PRESS.y + 22], PRESS_H, 6, 7);
// Review tray in front: two lanes split by a centre rail.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 4, 0.6), { tone: "lo" });
s.solid(
	slabOf(
		{ x: TRAY.x + 4, y: TRAY.y + TRAY.d / 2 - 1.5, w: TRAY.w - 8, d: 3, r: 1 },
		TRAY_H,
		4,
		s.P,
		2
	)
);
s.solid(
	slabOf(
		{ x: TRAY.x + 14, y: TRAY.y + 6, w: 30, d: 16, r: 2 },
		TRAY_H,
		9,
		s.P,
		3,
		0.6
	),
	{ lit: true }
);
s.line(
	planOutline(
		{ x: TRAY.x + 14, y: TRAY.y + 32, w: 30, d: 16, r: 2 },
		TRAY_H,
		s.P,
		3
	),
	{ tone: "faint" }
);

export const drawing = cardDrawing(s);
