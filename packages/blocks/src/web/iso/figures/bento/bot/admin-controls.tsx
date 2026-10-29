import {
	boxCorners,
	corners,
	insetPlan,
	type Point3,
	pathOf,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Admin controls: a slider panel, one slot per thing Bot could reach. The
 * admin has set each slider open or shut and padlocked the panel's hasp
 * (the lit padlock), so the settings stay where they were put.
 */

const PLATE = { x: -92, y: -52, w: 184, d: 104, r: 8 };
const PANEL = { x: -60, y: -38, w: 120, d: 62, r: 5 };
const PANEL_H = 20;
const SLOTS: [number, boolean][] = [
	[-42, true],
	[-20, false],
	[2, true],
	[24, false],
];
const SLOT_Y = -26;
const SLOT_D = 38;
const LOCK_X = 44;
const FRONT = PANEL.y + PANEL.d;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, 0, PANEL_H + 10],
]);

benchPlate(s, PLATE);
s.halo(PANEL, 0);
s.solid(slabOf(PANEL, 0, PANEL_H, s.P, 6, 1));
s.line(planOutline(insetPlan(PANEL, 4), PANEL_H, s.P, 4), { tone: "faint" });
screws(s, corners(PANEL, 7), PANEL_H, 1.3);
for (const [x, open] of SLOTS) {
	lamp(s, [x, SLOT_Y - 5], PANEL_H, { radius: 1.6 });
	s.line(
		planOutline(
			{ x: x - 3, y: SLOT_Y, w: 6, d: SLOT_D, r: 2 },
			PANEL_H,
			s.P,
			3
		),
		{ tone: "mid" }
	);
	const y = open ? SLOT_Y + 1 : SLOT_Y + SLOT_D - 13;
	s.solid(slabOf({ x: x - 6, y, w: 12, d: 12, r: 2 }, PANEL_H, 6, s.P, 3, 0.5));
	s.line(
		planOutline({ x: x - 3, y: y + 3, w: 6, d: 6, r: 1 }, PANEL_H + 6, s.P, 2),
		{ tone: "lo" }
	);
}
// The hasp on the panel's front face, and the padlock hanging through it.
s.solid(
	slabOf({ x: LOCK_X - 5, y: FRONT, w: 10, d: 10, r: 1 }, 15, 3.5, s.P, 2, 0.3)
);
for (const radius of [6, 8.5]) {
	const shackle: Point3[] = [];
	for (let i = 0; i <= 20; i++) {
		const angle = (i / 20) * Math.PI;
		shackle.push([
			LOCK_X + Math.cos(angle) * radius,
			FRONT + 5,
			13 + Math.sin(angle) * (radius + 1),
		]);
	}
	s.line(pathOf(shackle.map(s.at)), { tone: "hi" });
}
const body = { x: LOCK_X - 12, y: FRONT + 1, w: 24, d: 8, r: 2.5 };
s.halo(body, 0);
s.solid(slabOf(body, 0, 13, s.P, 3, 0.8), { lit: true });
s.line(faceRect(s, "y", FRONT + 9, LOCK_X - 1, LOCK_X + 1, 3, 8), {
	tone: "lo",
});

export const drawing = cardDrawing(s);
