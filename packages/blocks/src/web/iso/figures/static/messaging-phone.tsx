import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, ruler, screws } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Ryu Messaging: phone numbers, texts and voice for agents. A desk phone: a
 * keypad, a small display, the handset on its cradle with a coiled cord, and
 * the line lamp (the lit part) showing a call in.
 */

const WIDTH = 640;
const HEIGHT = 420;
const PLATE = { x: -92, y: -70, w: 156, d: 128, r: 8 };
const BODY = { x: -62, y: -50, w: 96, d: 76, r: 6 };
const BODY_H = 16;
const HANDSET = { x: -60, y: -46, w: 92, d: 16, r: 6 };
const HANDSET_Z = BODY_H + 9;

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [BODY.x, BODY.y, HANDSET_Z + 12]],
	WIDTH,
	HEIGHT
);

function base() {
	s.halo(BODY, 0, 6);
	s.solid(slabOf(BODY, 0, 5, s.P, 6, 0.8), { tone: "lo" });
	s.solid(slabOf(insetPlan(BODY, 2), 5, BODY_H - 5, s.P, 6, 1));
	const top = BODY_H;
	// Keypad: 3 × 4 keys.
	for (let row = 0; row < 4; row++) {
		for (let col = 0; col < 3; col++) {
			const key = {
				x: BODY.x + 14 + col * 11,
				y: BODY.y + 28 + row * 10,
				w: 8,
				d: 7,
				r: 1.4,
			};
			s.solid(slabOf(key, top, 1.8, s.P, 3, 0.3), { crease: "none" });
		}
	}
	// Display window with two rule lines.
	const display = { x: BODY.x + 54, y: BODY.y + 30, w: 34, d: 14, r: 1.5 };
	s.line(planOutline(display, top, s.P, 3), { tone: "mid" });
	s.line(
		lineOnTop(
			[display.x + 4, display.y + 5],
			[display.x + 24, display.y + 5],
			top,
			s.P
		),
		{ tone: "mid", free: true }
	);
	s.line(
		lineOnTop(
			[display.x + 4, display.y + 9],
			[display.x + 16, display.y + 9],
			top,
			s.P
		),
		{ tone: "faint", free: true }
	);
	// Function keys and the line lamp.
	for (let i = 0; i < 3; i++) {
		s.solid(
			slabOf(
				{ x: BODY.x + 56 + i * 11, y: BODY.y + 52, w: 8, d: 5, r: 1.2 },
				top,
				1.6,
				s.P,
				3
			),
			{ crease: "none" }
		);
	}
	lamp(s, [BODY.x + 82, BODY.y + 66], top, { lit: true });
	knob(s, [BODY.x + 62, BODY.y + 66], top, 3, 3);
	screws(
		s,
		[
			[BODY.x + 6, BODY.y + 70],
			[BODY.x + 90, BODY.y + 6],
		],
		top,
		1.2
	);
	// Cradle posts the handset rests on.
	for (const x of [HANDSET.x + 14, HANDSET.x + HANDSET.w - 22]) {
		s.solid(
			slabOf(
				{ x, y: HANDSET.y + 3, w: 8, d: 10, r: 2 },
				top,
				HANDSET_Z - top - 4,
				s.P,
				4,
				0.4
			)
		);
	}
}

function handset() {
	// Ear and mouth cups hang under the grip.
	for (const x of [HANDSET.x + 6, HANDSET.x + HANDSET.w - 6]) {
		const y = HANDSET.y + HANDSET.d / 2;
		s.solid(cylinder(x, y, 9, HANDSET_Z - 5, 5, s.P, 36, 0.6));
		s.line(ring(x, y, 5, HANDSET_Z - 5, s.P, 24), { tone: "faint" });
	}
	s.solid(slabOf(HANDSET, HANDSET_Z, 6, s.P, 6, 1), {
		tone: "hi",
		crease: "lo",
	});
	s.line(planOutline(insetPlan(HANDSET, 3), HANDSET_Z + 6, s.P, 4), {
		tone: "faint",
	});
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 12, y: PLATE.y + PLATE.d - 14, w: 70, d: 7, r: 1 });
// Coiled cord from the base's left side up to the handset end.
const cord: [number, number, number][] = [];
for (let i = 0; i <= 18; i++) {
	const t = i / 18;
	cord.push([
		BODY.x - 6 + Math.sin(t * Math.PI * 8) * 2,
		BODY.y + 10 + t * 40,
		2 + Math.cos(t * Math.PI * 8) * 1.4,
	]);
}
s.wire([BODY.x + 2, BODY.y + 8, 3], [BODY.x + 2, BODY.y + 54, 3], cord, {
	tone: "mid",
});
base();
handset();

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
