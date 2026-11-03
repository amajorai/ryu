import {
	boxCorners,
	corners,
	cylinder,
	dotGrid,
	insetPlan,
	lineOnTop,
	type Plan,
	planOutline,
	ring,
	sideArc,
	slabOf,
} from "../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	faceRules,
	lamp,
	ruler,
	screws,
} from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Ryu Pro: one person's agent workspace. A single workbench: a screen and
 * keyboard with a mug beside them, one cloud computer on its riser at the back
 * (its power lamp the lit part), and a credits meter, a bar of segments being
 * drawn down as the computer works, with a short stack of coins for the
 * month's allowance. No numbers: the page carries the figures.
 */

const WIDTH = 640;
const HEIGHT = 440;
const PLATE = { x: -134, y: -86, w: 256, d: 160, r: 8 };
const RISER = { x: 14, y: -76, w: 70, d: 54, r: 3 };
const RISER_H = 6;
const TOWER = { x: 24, y: -68, w: 48, d: 38, r: 3 };
const TOWER_H = 92;
const SCREEN = { x: -112, y: -58, w: 84, d: 4, r: 1.5 };
const SCREEN_Z = 22;
const SCREEN_H = 50;
const KEYS = { x: -108, y: -18, w: 74, d: 24, r: 2 };
const MUG: [number, number] = [-14, 0];
const METER = { x: 4, y: 20, w: 92, d: 30, r: 3 };
const METER_H = 14;
const SEGMENTS = 12;
const DRAWN = 4;
const COINS: [number, number] = [-20, 44];

const s = createSketch(
	[
		...boxCorners(PLATE, -15, 0),
		[TOWER.x, TOWER.y, RISER_H + TOWER_H + 6],
		[SCREEN.x, SCREEN.y, SCREEN_Z + SCREEN_H + 4],
	],
	WIDTH,
	HEIGHT
);

function cloudComputer() {
	s.halo(RISER, 0);
	s.solid(slabOf(RISER, 0, RISER_H, s.P, 4, 0.8), { tone: "lo" });
	screws(s, corners(RISER, 4), RISER_H, 1.2);
	s.halo(TOWER, RISER_H, 6);
	s.solid(slabOf(TOWER, RISER_H, TOWER_H, s.P, 4, 1.2));
	const top = RISER_H + TOWER_H;
	s.dots(dotGrid(TOWER.x + 8, TOWER.y + 7, 8, 6, 4.6, top, s.P), {
		size: 0.45,
		tone: "lo",
	});
	lamp(s, [TOWER.x + TOWER.w - 8, TOWER.y + TOWER.d - 7], top, { lit: true });
	const face = TOWER.y + TOWER.d;
	// Front: a drive bay, vent rules, and the power button.
	s.line(
		faceRect(
			s,
			"y",
			face,
			TOWER.x + 6,
			TOWER.x + TOWER.w - 6,
			top - 20,
			top - 8
		),
		{ tone: "mid" }
	);
	faceRules(s, "y", face, TOWER.x + 10, top - 14, [20], 0);
	for (let i = 0; i < 9; i++) {
		const z = RISER_H + 12 + i * 5.5;
		s.line(
			faceRect(s, "y", face, TOWER.x + 8, TOWER.x + TOWER.w - 8, z, z + 1.6),
			{ tone: i % 4 === 0 ? "mid" : "faint" }
		);
	}
	// Side: a fan grille on the right face.
	const side = TOWER.x + TOWER.w;
	s.line(faceRect(s, "x", side, TOWER.y + 6, TOWER.y + TOWER.d - 6, 40, 72), {
		tone: "faint",
	});
}

function screen() {
	const [cx, cy] = [SCREEN.x + SCREEN.w / 2, SCREEN.y - 4];
	s.halo({ x: cx - 16, y: cy - 10, w: 32, d: 20, r: 6 }, 0);
	s.solid(slabOf({ x: cx - 16, y: cy - 10, w: 32, d: 20, r: 6 }, 0, 3, s.P, 6));
	s.solid(
		slabOf({ x: cx - 4, y: cy - 3, w: 8, d: 5, r: 1 }, 3, SCREEN_Z, s.P, 3),
		{ tone: "lo", crease: "none" }
	);
	s.solid(slabOf(SCREEN, SCREEN_Z, SCREEN_H, s.P, 3, 0.6));
	const face = SCREEN.y + SCREEN.d;
	s.line(
		faceRect(
			s,
			"y",
			face,
			SCREEN.x + 4,
			SCREEN.x + SCREEN.w - 4,
			SCREEN_Z + 4,
			SCREEN_Z + SCREEN_H - 4
		)
	);
	// A single conversation on screen: alternating message rules.
	faceRules(
		s,
		"y",
		face,
		SCREEN.x + 10,
		SCREEN_Z + SCREEN_H - 12,
		[38, 52, 30, 46],
		7
	);
}

function keyboard() {
	s.halo(KEYS, 0);
	s.solid(slabOf(KEYS, 0, 4, s.P, 4, 0.6));
	s.dots(dotGrid(KEYS.x + 5, KEYS.y + 4, 14, 4, 5, 4, s.P), {
		size: 0.45,
		tone: "lo",
	});
	s.line(
		planOutline(
			{ x: KEYS.x + 20, y: KEYS.y + KEYS.d - 5, w: 34, d: 2.4, r: 0.8 },
			4,
			s.P,
			2
		),
		{ tone: "faint" }
	);
}

function mug() {
	const [x, y] = MUG;
	s.halo({ x: x - 7, y: y - 7, w: 14, d: 14, r: 7 }, 0);
	s.solid(cylinder(x, y, 7, 0, 16, s.P, 40, 0.6));
	s.line(ring(x, y, 5.6, 16, s.P, 40), { tone: "mid" });
	s.line(sideArc(x, y, 7, 5, s.P, 24), { tone: "faint" });
	s.solid(
		slabOf({ x: x + 6, y: y - 1.2, w: 5, d: 2.4, r: 1.2 }, 4, 9, s.P, 3),
		{ crease: "none" }
	);
}

/** The credits meter: a bar of segments, the drawn-down ones sunk and empty. */
function creditsMeter() {
	s.halo(METER, 0);
	s.solid(slabOf(METER, 0, METER_H, s.P, 4, 1));
	screws(s, corners(METER, 4), METER_H, 1.1);
	const slot: Plan = {
		x: METER.x + 8,
		y: METER.y + 8,
		w: METER.w - 30,
		d: 12,
		r: 1.5,
	};
	s.line(planOutline(slot, METER_H, s.P, 3), { tone: "mid" });
	const pitch = slot.w / SEGMENTS;
	for (let i = 0; i < SEGMENTS; i++) {
		const segment = {
			x: slot.x + i * pitch + 0.8,
			y: slot.y + 2,
			w: pitch - 1.6,
			d: slot.d - 4,
			r: 0.4,
		};
		if (i < SEGMENTS - DRAWN) {
			s.solid(slabOf(segment, METER_H, 1.4, s.P, 2), {
				tone: "hi",
				crease: "lo",
			});
		} else {
			s.line(planOutline(segment, METER_H, s.P, 2), { tone: "faint" });
		}
	}
	// The coin slot the month's allowance drops into.
	const coinSlot = {
		x: METER.x + METER.w - 16,
		y: METER.y + 9,
		w: 3,
		d: 12,
		r: 1,
	};
	s.solid(slabOf(insetPlan(coinSlot, -2), METER_H, 1, s.P, 2), {
		tone: "lo",
	});
	s.line(planOutline(coinSlot, METER_H + 1, s.P, 2), { tone: "hi" });
}

function coinStack() {
	const [x, y] = COINS;
	s.halo({ x: x - 9, y: y - 9, w: 18, d: 18, r: 9 }, 0);
	for (let i = 0; i < 4; i++) {
		const z = i * 2.6;
		s.solid(cylinder(x + (i % 2) * 0.6, y, 8, z, 2.2, s.P, 40, 0.4), {
			tone: i === 3 ? "hi" : "mid",
			crease: "lo",
		});
	}
	s.line(ring(x + 0.6, y, 5.4, 10.4, s.P, 32), { tone: "lo" });
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 16, w: 92, d: 7, r: 1 });
cloudComputer();
screen();
// The screen reaches the cloud computer over the network, not a cable.
s.line(
	lineOnTop(
		[SCREEN.x + SCREEN.w + 4, SCREEN.y + 2],
		[RISER.x - 4, SCREEN.y + 2],
		0.6,
		s.P
	),
	{ dotted: true, tone: "mid" }
);
s.wire(
	[RISER.x + RISER.w / 2, RISER.y + RISER.d, 3],
	[METER.x + METER.w - 30, METER.y, 8],
	[
		[RISER.x + RISER.w / 2, METER.y - 6, 0.8],
		[METER.x + METER.w - 30, METER.y - 6, 0.8],
	],
	{ flow: true }
);
keyboard();
mug();
creditsMeter();
coinStack();

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
