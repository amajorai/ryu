import {
	boxCorners,
	corners,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../kit/iso-kit.ts";
import { benchPlate, faceRect, knob, lamp, ruler, screws } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Agent: run Ryu with the models, tools, permissions and records you choose.
 * A mixing desk: one channel strip per choice, each with knobs, a lamp and a
 * fader; the master fader (the lit part) sets the run, and a meter bridge
 * stands at the back.
 */

const WIDTH = 640;
const HEIGHT = 420;
const PLATE = { x: -140, y: -84, w: 270, d: 160, r: 8 };
const DESK = { x: -120, y: -56, w: 220, d: 100, r: 5 };
const DESK_H = 14;
const STRIPS = 7;
const STRIP_W = 24;
const BRIDGE = { x: -116, y: -74, w: 212, d: 14, r: 2 };
const BRIDGE_H = 34;
const FADER_LEVELS = [0.6, 0.3, 0.8, 0.45, 0.7, 0.2];

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [BRIDGE.x, BRIDGE.y, BRIDGE_H + 6]],
	WIDTH,
	HEIGHT
);

function bridge() {
	s.halo(BRIDGE, 0);
	s.solid(slabOf(BRIDGE, 0, BRIDGE_H, s.P, 3, 0.8));
	const face = BRIDGE.y + BRIDGE.d;
	for (let i = 0; i < STRIPS; i++) {
		const x = DESK.x + 8 + i * (STRIP_W + 4);
		s.line(faceRect(s, "y", face, x + 4, x + STRIP_W - 4, 8, BRIDGE_H - 6), {
			tone: "mid",
		});
		const level = i === STRIPS - 1 ? 0.75 : (FADER_LEVELS[i] ?? 0.5);
		const segments = Math.round(level * 6);
		for (let k = 0; k < segments; k++) {
			s.line(
				faceRect(
					s,
					"y",
					face,
					x + 7,
					x + STRIP_W - 7,
					10 + k * 3,
					11.6 + k * 3
				),
				{
					tone: i === STRIPS - 1 ? "hi" : "lo",
				}
			);
		}
	}
}

function desk() {
	s.halo(DESK, 0);
	s.solid(slabOf(DESK, 0, DESK_H, s.P, 5, 1));
	screws(s, corners(DESK, 4), DESK_H, 1.2);
	for (let i = 0; i < STRIPS; i++) {
		const x = DESK.x + 8 + i * (STRIP_W + 4);
		const strip = { x, y: DESK.y + 6, w: STRIP_W, d: DESK.d - 12, r: 2 };
		const master = i === STRIPS - 1;
		s.line(planOutline(strip, DESK_H, s.P, 2), {
			tone: master ? "mid" : "faint",
		});
		const cx = x + STRIP_W / 2;
		knob(s, [cx, strip.y + 9], DESK_H, 3.4, 3.5);
		knob(s, [cx, strip.y + 22], DESK_H, 2.8, 3);
		lamp(s, [cx, strip.y + 33], DESK_H, { radius: 1.6, lit: master });
		// Fader slot and cap.
		const slotTop = strip.y + 42;
		const slotLength = 40;
		s.line(
			planOutline(
				{ x: cx - 1, y: slotTop, w: 2, d: slotLength, r: 1 },
				DESK_H,
				s.P,
				2
			)
		);
		const level = master ? 0.25 : 1 - (FADER_LEVELS[i] ?? 0.5);
		const capY = slotTop + level * (slotLength - 6);
		s.solid(
			slabOf({ x: cx - 5, y: capY, w: 10, d: 6, r: 1 }, DESK_H, 4, s.P, 3, 0.4),
			{
				lit: master,
				tone: master ? "hi" : "mid",
			}
		);
		s.line(lineOnTop([cx - 3, capY + 3], [cx + 3, capY + 3], DESK_H + 4, s.P), {
			tone: "faint",
		});
	}
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 14, w: 140, d: 7, r: 1 });
bridge();
desk();

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
