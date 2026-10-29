import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, ruler } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Ryu Mobile: your agents in your pocket. A phone lying on a charging pad,
 * a conversation on its screen and its notification light (the lit part) on,
 * cabled to the home server it talks to.
 */

const WIDTH = 620;
const HEIGHT = 420;
const PLATE = { x: -130, y: -80, w: 250, d: 150, r: 8 };
const PAD: [number, number] = [-40, -6];
const PAD_R = 44;
const PHONE = { x: -64, y: -52, w: 48, d: 92, r: 8 };
const PHONE_Z = 7;
const SERVER = { x: 44, y: -52, w: 58, d: 70, r: 4 };

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [SERVER.x, SERVER.y, 40]],
	WIDTH,
	HEIGHT
);
const top = PHONE_Z + 6;

function pad() {
	const [x, y] = PAD;
	s.halo(
		{ x: x - PAD_R, y: y - PAD_R, w: PAD_R * 2, d: PAD_R * 2, r: PAD_R },
		0
	);
	s.solid(cylinder(x, y, PAD_R, 0, 3, s.P, 72, 0.6), { tone: "lo" });
	s.solid(cylinder(x, y, PAD_R - 3, 3, 4, s.P, 72, 0.6));
	s.line(ring(x, y, PAD_R - 8, PHONE_Z, s.P, 72), { tone: "faint" });
}

function phone() {
	s.solid(slabOf(PHONE, PHONE_Z, 6, s.P, 8, 0.8), { tone: "hi", crease: "lo" });
	const glass = insetPlan(PHONE, 3);
	s.line(planOutline(glass, top, s.P, 6), { tone: "mid" });
	s.line(
		lineOnTop(
			[PHONE.x + 18, PHONE.y + 6],
			[PHONE.x + 30, PHONE.y + 6],
			top,
			s.P
		),
		{ tone: "mid" }
	);
	// A chat: alternating bubbles down the screen.
	const bubbles = [
		{ x: glass.x + 4, y: glass.y + 12, w: 26, d: 9 },
		{ x: glass.x + glass.w - 34, y: glass.y + 26, w: 30, d: 12 },
		{ x: glass.x + 4, y: glass.y + 44, w: 30, d: 9 },
		{ x: glass.x + glass.w - 26, y: glass.y + 58, w: 22, d: 9 },
	];
	for (const [i, bubble] of bubbles.entries()) {
		s.line(planOutline({ ...bubble, r: 3 }, top, s.P, 4), {
			tone: i === 3 ? "mid" : "lo",
		});
	}
	s.line(
		planOutline(
			{
				x: glass.x + 4,
				y: glass.y + glass.d - 11,
				w: glass.w - 8,
				d: 7,
				r: 3.5,
			},
			top,
			s.P,
			4
		),
		{ tone: "mid" }
	);
	lamp(s, [PHONE.x + PHONE.w - 9, PHONE.y + 6], top - 1.6, {
		lit: true,
		radius: 1.4,
	});
}

function server() {
	s.halo(SERVER, 0);
	s.solid(slabOf(SERVER, 0, 30, s.P, 4, 1));
	s.line(planOutline(insetPlan(SERVER, 5), 30, s.P, 3), { tone: "faint" });
	for (let i = 0; i < 5; i++) {
		s.line(
			lineOnTop(
				[SERVER.x + 10, SERVER.y + 14 + i * 4],
				[SERVER.x + 40, SERVER.y + 14 + i * 4],
				30,
				s.P
			)
		);
	}
	lamp(s, [SERVER.x + SERVER.w - 10, SERVER.y + 10], 30);
	knob(s, [SERVER.x + SERVER.w - 10, SERVER.y + SERVER.d - 12], 30, 3.4, 3);
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 14, w: 120, d: 7, r: 1 });
s.wire(
	[PAD[0] + PAD_R - 2, PAD[1], 2],
	[SERVER.x, SERVER.y + 50, 6],
	[
		[SERVER.x - 10, PAD[1], 0.8],
		[SERVER.x - 10, SERVER.y + 50, 0.8],
	],
	{
		flow: true,
	}
);
pad();
phone();
server();

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
