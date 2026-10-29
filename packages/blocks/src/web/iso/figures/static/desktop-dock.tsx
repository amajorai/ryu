import {
	boxCorners,
	corners,
	cylinder,
	dotGrid,
	insetPlan,
	lineOnTop,
	onTop,
	planOutline,
	ring,
	sideArc,
	slabOf,
} from "../../kit/iso-kit.ts";
import {
	benchPlate,
	byDepth,
	faceRect,
	faceRules,
	jack,
	knob,
	lamp,
	ruler,
	screws,
} from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Ryu Desktop: one Core on your desk, reached from every screen. A hub on a
 * bench plate (its lamp the lit part) is cabled to a workstation, a phone in a
 * cradle and a round terminal puck.
 */

const WIDTH = 640;
const HEIGHT = 420;
const PLATE = { x: -146, y: -76, w: 266, d: 138, r: 8 };
const HUB = { x: -30, y: -22, w: 60, d: 46, r: 4 };
const HUB_H = 20;
const DESK = { x: -136, y: -64, w: 80, d: 54, r: 3 };
const SCREEN_H = 52;
const CRADLE = { x: 64, y: -64, w: 46, d: 26, r: 3 };
const PHONE = { x: 71, y: -58, w: 32, d: 4.5, r: 2.5 };
const PUCK: [number, number] = [72, 30];
const PUCK_R = 18;

const s = createSketch(
	[
		...boxCorners(PLATE, -15, 0),
		[DESK.x, DESK.y, SCREEN_H + 6],
		[PHONE.x + PHONE.w, PHONE.y, 66],
	],
	WIDTH,
	HEIGHT
);

function workstation() {
	s.halo(DESK, 0);
	s.solid(slabOf(DESK, 0, 5, s.P, 5, 0.6));
	const keys = { x: DESK.x + 8, y: DESK.y + 14, w: DESK.w - 16, d: 22, r: 1.5 };
	s.line(planOutline(keys, 5, s.P, 3), { tone: "faint" });
	s.dots(dotGrid(keys.x + 4, keys.y + 3.5, 13, 4, 5, 5, s.P), {
		size: 0.45,
		tone: "lo",
	});
	s.line(
		planOutline(
			{ x: DESK.x + DESK.w / 2 - 12, y: DESK.y + 40, w: 24, d: 11, r: 1.5 },
			5,
			s.P,
			3
		)
	);
	s.solid(
		slabOf(
			{ x: DESK.x + 6, y: DESK.y, w: DESK.w - 12, d: 5, r: 2 },
			5,
			3,
			s.P,
			4
		)
	);
	const lid = { x: DESK.x + 2, y: DESK.y - 1, w: DESK.w - 4, d: 3.5, r: 1.2 };
	s.solid(slabOf(lid, 6, SCREEN_H, s.P, 3, 0.4));
	const face = lid.y + lid.d;
	s.line(
		faceRect(s, "y", face, lid.x + 4, lid.x + lid.w - 4, 10, 6 + SCREEN_H - 4)
	);
	faceRules(
		s,
		"y",
		face,
		lid.x + 10,
		6 + SCREEN_H - 12,
		[44, 52, 36, 48, 28],
		6
	);
}

function phone() {
	s.solid(slabOf(CRADLE, 0, 7, s.P, 5, 0.6));
	s.line(planOutline(insetPlan(CRADLE, 3), 7, s.P, 3), { tone: "faint" });
	screws(s, corners(CRADLE, 4), 7, 1.4);
	s.solid(
		slabOf(
			{ x: PHONE.x + 4, y: PHONE.y - 3, w: PHONE.w - 8, d: 3, r: 1 },
			7,
			30,
			s.P,
			3
		)
	);
	s.solid(slabOf(PHONE, 7, 58, s.P, 6, 0.5), { tone: "hi", crease: "lo" });
	const face = PHONE.y + PHONE.d;
	s.line(
		faceRect(s, "y", face, PHONE.x + 2.5, PHONE.x + PHONE.w - 2.5, 12, 60)
	);
	faceRules(s, "y", face, PHONE.x + 6, 52, [18, 22, 14], 7);
	s.solid(
		slabOf(
			{ x: CRADLE.x + 4, y: face + 1, w: CRADLE.w - 8, d: 3, r: 1 },
			7,
			4,
			s.P,
			3
		)
	);
}

function hub() {
	s.halo(HUB, 0);
	s.solid(slabOf(HUB, 0, 4, s.P, 6, 0.8), { tone: "lo" });
	const top = insetPlan(HUB, 2);
	s.solid(slabOf(top, 4, HUB_H - 4, s.P, 6, 0.8), { tone: "hi", crease: "lo" });
	s.line(planOutline(insetPlan(top, 4), HUB_H, s.P, 4), { tone: "faint" });
	for (let i = 0; i < 6; i++) {
		const y = top.y + 9 + i * 3.2;
		s.line(lineOnTop([top.x + 9, y], [top.x + 26, y], HUB_H, s.P));
	}
	lamp(s, [top.x + top.w - 11, top.y + 10], HUB_H, { lit: true });
	knob(s, [top.x + top.w - 11, top.y + top.d - 11], HUB_H, 4.2);
	screws(s, corners(top, 3.5), HUB_H, 1.3);
	for (const x of [-12, 0, 12]) {
		jack(s, [x, top.y + top.d - 6], HUB_H);
	}
}

function puck() {
	const [x, y] = PUCK;
	s.halo(
		{ x: x - PUCK_R, y: y - PUCK_R, w: PUCK_R * 2, d: PUCK_R * 2, r: PUCK_R },
		0
	);
	s.solid(cylinder(x, y, PUCK_R, 0, 3, s.P, 64), { tone: "lo" });
	s.solid(cylinder(x, y, PUCK_R - 1.5, 3, 9, s.P, 64, 0.8));
	s.line(sideArc(x, y, PUCK_R - 1.5, 7.5, s.P, 40), { tone: "faint" });
	s.line(ring(x, y, PUCK_R - 5, 12, s.P, 64));
	s.line(
		onTop(
			[
				[x - 7, y - 4],
				[x - 4, y - 1],
				[x - 7, y + 2],
			],
			12,
			s.P
		),
		{ tone: "hi" }
	);
	s.solid(
		slabOf({ x: x - 1, y: y - 1.5, w: 5, d: 3, r: 0.4 }, 12, 0.4, s.P, 2),
		{ crease: "none" }
	);
}

function cables() {
	const lidFront = HUB.y + HUB.d - 2 - 6;
	const z = 0.8;
	s.wire(
		[-12, lidFront, HUB_H],
		[-70, DESK.y + DESK.d, 2.5],
		[
			[-12, HUB.y + HUB.d + 6, z],
			[-70, HUB.y + HUB.d + 6, z],
		]
	);
	s.wire(
		[12, lidFront, HUB_H],
		[CRADLE.x + 10, CRADLE.y + CRADLE.d, 3.5],
		[
			[12, HUB.y + HUB.d + 10, z],
			[52, HUB.y + HUB.d + 10, z],
			[52, CRADLE.y + CRADLE.d + 6, z],
			[CRADLE.x + 10, CRADLE.y + CRADLE.d + 6, z],
		]
	);
	s.wire(
		[0, lidFront, HUB_H],
		[PUCK[0] - PUCK_R + 1, PUCK[1], 4],
		[[0, PUCK[1], z]],
		{ flow: true }
	);
}

benchPlate(s, PLATE);
ruler(s, { x: -130, y: PLATE.y + PLATE.d - 16, w: 130, d: 7, r: 1 });
cables();
for (const [, , draw] of byDepth<[number, number, () => void]>(
	[
		[DESK.x + DESK.w / 2, DESK.y + DESK.d / 2, workstation],
		[CRADLE.x + CRADLE.w / 2, CRADLE.y + CRADLE.d / 2, phone],
		[0, 0, hub],
		[PUCK[0], PUCK[1], puck],
	],
	s
)) {
	draw();
}

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
