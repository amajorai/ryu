import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../kit/iso-kit.ts";
import { benchPlate, faceRect, faceRules, knob, lamp, ruler } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Ryu CLI: the runtime in a terminal. A desk terminal with its screen showing
 * a few lines and a lit cursor, a keyboard on a coiled lead, and a brightness
 * knob, on a bench plate.
 */

const WIDTH = 640;
const HEIGHT = 420;
const PLATE = { x: -120, y: -80, w: 230, d: 170, r: 8 };
const BODY = { x: -78, y: -66, w: 96, d: 66, r: 5 };
const BODY_H = 74;
const KEYS = { x: -82, y: 14, w: 104, d: 40, r: 3 };
const KEYS_H = 6;

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [BODY.x, BODY.y, BODY_H + 4]],
	WIDTH,
	HEIGHT
);
const face = BODY.y + BODY.d;

function terminal() {
	s.halo(BODY, 0, 6);
	// Plinth, then the case standing on it.
	s.solid(slabOf(insetPlan(BODY, -3), 0, 6, s.P, 6, 0.8), { tone: "lo" });
	s.solid(slabOf(BODY, 6, BODY_H - 6, s.P, 6, 1.2));
	// Vents along the lid.
	for (let i = 0; i < 9; i++) {
		const x = BODY.x + 14 + i * 7;
		s.line(lineOnTop([x, BODY.y + 10], [x, BODY.y + 34], BODY_H, s.P));
	}
	knob(s, [BODY.x + BODY.w - 14, BODY.y + 20], BODY_H, 4.5, 4);
	lamp(s, [BODY.x + BODY.w - 14, BODY.y + 40], BODY_H);
	// Bezel, screen, lines of output and the cursor.
	s.line(
		faceRect(s, "y", face, BODY.x + 8, BODY.x + BODY.w - 8, 16, BODY_H - 8),
		{ tone: "mid" }
	);
	s.line(
		faceRect(s, "y", face, BODY.x + 13, BODY.x + BODY.w - 13, 21, BODY_H - 13)
	);
	faceRules(
		s,
		"y",
		face,
		BODY.x + 18,
		BODY_H - 20,
		[52, 38, 60, 44, 30, 12],
		6
	);
	s.solid(
		slabOf(
			{ x: BODY.x + 33, y: face, w: 4.5, d: 0.6, r: 0 },
			BODY_H - 20 - 5 * 6 - 1.6,
			3.6,
			s.P,
			1
		),
		{
			lit: true,
			crease: "none",
		}
	);
	// Badge strip under the screen.
	s.line(
		faceRect(s, "y", face, BODY.x + BODY.w - 30, BODY.x + BODY.w - 10, 9, 12),
		{ tone: "faint" }
	);
}

function keyboard() {
	s.halo(KEYS, 0, 5);
	s.solid(slabOf(KEYS, 0, KEYS_H, s.P, 4, 0.8));
	const deck = insetPlan(KEYS, 4);
	s.line(planOutline(deck, KEYS_H, s.P, 3), { tone: "faint" });
	for (let row = 0; row < 3; row++) {
		for (let col = 0; col < 12; col++) {
			const key = {
				x: deck.x + 2 + col * 8,
				y: deck.y + 2 + row * 8,
				w: 6.4,
				d: 6.4,
				r: 1,
			};
			s.solid(slabOf(key, KEYS_H, 1.4, s.P, 2, 0.3), { crease: "none" });
		}
	}
	s.solid(
		slabOf(
			{ x: deck.x + 26, y: deck.y + 25, w: 44, d: 6.4, r: 1 },
			KEYS_H,
			1.4,
			s.P,
			2,
			0.3
		),
		{ crease: "none" }
	);
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 16, w: 120, d: 7, r: 1 });
terminal();
// Coiled lead from the keyboard's back edge to the case.
const lead: [number, number, number][] = [];
for (let i = 0; i <= 14; i++) {
	const t = i / 14;
	lead.push([
		28 + Math.sin(t * Math.PI * 6) * 2.2,
		14 - t * 13,
		2 + Math.cos(t * Math.PI * 6) * 1.6,
	]);
}
s.wire([28, 14, 3], [28, face - 0.5, 8], lead, { tone: "mid" });
keyboard();

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
