import {
	boxCorners,
	corners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../kit/iso-kit.ts";
import { benchPlate, faceRect, knob, lamp, ruler, screws } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Skills: install a skill in one move. A console with cartridge slots: two
 * skills already seated, one cartridge (the lit part) going into the open
 * slot, and spares waiting in a rack beside it.
 */

const WIDTH = 640;
const HEIGHT = 420;
const PLATE = { x: -140, y: -80, w: 260, d: 150, r: 8 };
const CONSOLE = { x: -110, y: -54, w: 120, d: 70, r: 5 };
const CONSOLE_H = 16;
const SLOTS = [-92, -62, -32];
const CART = { w: 22, d: 5, h: 26 };
const OPEN = 2;
const LIFT = 22;
const RACK = { x: 38, y: -54, w: 70, d: 26, r: 3 };

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [-32, -40, CONSOLE_H + CART.h + LIFT + 4]],
	WIDTH,
	HEIGHT
);
const slotY = CONSOLE.y + 22;

function cartridge(x: number, y: number, z: number, lit = false) {
	const plan = { x, y, w: CART.w, d: CART.d, r: 0.8 };
	s.solid(slabOf(plan, z, CART.h, s.P, 3, 0.5), {
		lit,
		tone: lit ? "hi" : "mid",
	});
	const face = y + CART.d;
	s.line(faceRect(s, "y", face, x + 3, x + CART.w - 3, z + 8, z + CART.h - 4), {
		tone: lit ? "mid" : "lo",
	});
	for (let i = 0; i < 3; i++) {
		s.line(
			lineOnTop(
				[x + 4 + i * 4, y + 1],
				[x + 4 + i * 4, y + CART.d - 1],
				z + CART.h,
				s.P
			),
			{ tone: "faint" }
		);
	}
}

function consoleBody() {
	s.halo(CONSOLE, 0);
	s.solid(slabOf(CONSOLE, 0, CONSOLE_H, s.P, 5, 1));
	screws(s, corners(CONSOLE, 4), CONSOLE_H, 1.2);
	for (const x of SLOTS) {
		s.line(
			planOutline(
				{ x: x - 1.5, y: slotY - 1.5, w: CART.w + 3, d: CART.d + 3, r: 1 },
				CONSOLE_H,
				s.P,
				2
			),
			{ tone: "mid" }
		);
	}
	// Front face: a vent band and the power lamp.
	const face = CONSOLE.y + CONSOLE.d;
	for (let i = 0; i < 8; i++) {
		s.line(
			faceRect(
				s,
				"y",
				face,
				CONSOLE.x + 10 + i * 6,
				CONSOLE.x + 13 + i * 6,
				4,
				11
			),
			{ tone: "faint" }
		);
	}
	lamp(s, [CONSOLE.x + CONSOLE.w - 12, CONSOLE.y + CONSOLE.d - 12], CONSOLE_H, {
		lit: true,
	});
	knob(
		s,
		[CONSOLE.x + CONSOLE.w - 28, CONSOLE.y + CONSOLE.d - 12],
		CONSOLE_H,
		3.6,
		4
	);
}

function rack() {
	s.halo(RACK, 0);
	s.solid(slabOf(RACK, 0, 6, s.P, 3, 0.6));
	s.line(planOutline(insetPlan(RACK, 3), 6, s.P, 2), { tone: "faint" });
	for (let i = 0; i < 3; i++) {
		cartridge(RACK.x + 2 + i * 23 - 0.5, RACK.y + 10, 6);
	}
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 16, w: 120, d: 7, r: 1 });
consoleBody();
SLOTS.forEach((x, index) => {
	if (index !== OPEN) {
		cartridge(x, slotY, CONSOLE_H - 8);
	}
});
rack();
const openX = SLOTS[OPEN] ?? 0;
s.halo({ x: openX, y: slotY, w: CART.w, d: CART.d, r: 1 }, CONSOLE_H, 3);
cartridge(openX, slotY, CONSOLE_H + LIFT, true);

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
