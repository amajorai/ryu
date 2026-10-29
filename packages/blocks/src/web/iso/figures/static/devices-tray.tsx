import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../kit/iso-kit.ts";
import { faceRect, faceRules, lamp, ruler, screws } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Ryu Devices: a watch, a necklace and a desk display for your Ryu server.
 * A display tray: the watch lying on its strap with its face lit, the pendant
 * on its chain, and the desk display standing at the back.
 */

const WIDTH = 620;
const HEIGHT = 420;
const TRAY = { x: -130, y: -80, w: 250, d: 150, r: 10 };
const TRAY_H = 10;
const DISPLAY = { x: -110, y: -66, w: 90, d: 30, r: 4 };
const WATCH: [number, number] = [26, 6];
const PENDANT: [number, number] = [-56, 34];

const s = createSketch(
	[...boxCorners(TRAY, 0, TRAY_H), [DISPLAY.x, DISPLAY.y, 74]],
	WIDTH,
	HEIGHT
);
const floor = 4;

function tray() {
	s.halo(TRAY, 0, 9);
	s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 8, 1.4));
	const well = insetPlan(TRAY, 8);
	s.line(planOutline(well, TRAY_H, s.P, 6), { tone: "mid" });
	s.solid(slabOf(well, floor, 0.4, s.P, 6), { tone: "lo", crease: "none" });
	screws(
		s,
		[
			[TRAY.x + 4, TRAY.y + TRAY.d / 2],
			[TRAY.x + TRAY.w - 4, TRAY.y + TRAY.d / 2],
		],
		TRAY_H,
		1.2
	);
}

function display() {
	s.solid(slabOf(DISPLAY, floor, 6, s.P, 4, 0.6));
	const panel = {
		x: DISPLAY.x + 6,
		y: DISPLAY.y + 8,
		w: DISPLAY.w - 12,
		d: 5,
		r: 2,
	};
	s.solid(slabOf(panel, floor + 6, 54, s.P, 3, 0.6));
	const face = panel.y + panel.d;
	s.line(
		faceRect(
			s,
			"y",
			face,
			panel.x + 4,
			panel.x + panel.w - 4,
			floor + 12,
			floor + 56
		),
		{ tone: "mid" }
	);
	faceRules(s, "y", face, panel.x + 10, floor + 46, [40, 30, 48], 8);
	lamp(s, [DISPLAY.x + DISPLAY.w - 8, DISPLAY.y + DISPLAY.d - 6], floor + 6, {
		radius: 1.6,
	});
}

function watch() {
	const [x, y] = WATCH;
	// Strap lying across the tray, then the case on it.
	s.solid(
		slabOf({ x: x - 9, y: y - 40, w: 18, d: 80, r: 6 }, floor, 2, s.P, 6),
		{ crease: "none" }
	);
	for (let i = 0; i < 4; i++) {
		s.line(
			lineOnTop(
				[x - 3, y + 22 + i * 4],
				[x + 3, y + 22 + i * 4],
				floor + 2,
				s.P
			),
			{ tone: "faint" }
		);
	}
	s.solid(cylinder(x, y, 16, floor + 2, 6, s.P, 64, 0.8));
	s.solid(cylinder(x + 17, y, 2.2, floor + 4, 3, s.P, 16));
	s.solid(cylinder(x, y, 13, floor + 8, 1, s.P, 64), { lit: true });
	s.line(ring(x, y, 10, floor + 9, s.P, 48), { tone: "faint" });
	s.line(lineOnTop([x, y], [x + 6, y - 5], floor + 9.2, s.P), { tone: "hi" });
	s.line(lineOnTop([x, y], [x - 2, y + 8], floor + 9.2, s.P), { tone: "mid" });
}

function pendant() {
	const [x, y] = PENDANT;
	// The chain as a loop of links lying on the tray, then the pendant.
	const links: [number, number, number][] = [];
	for (let i = 0; i <= 24; i++) {
		const a = (i / 24) * Math.PI * 2;
		links.push([x + Math.cos(a) * 34, y - 18 + Math.sin(a) * 16, floor + 0.6]);
	}
	s.wire(
		links[0] ?? [x, y, floor],
		links.at(-1) ?? [x, y, floor],
		links.slice(1, -1),
		{ tone: "mid" }
	);
	s.solid(cylinder(x, y, 9, floor, 4, s.P, 48, 0.8), {
		tone: "hi",
		crease: "lo",
	});
	s.line(ring(x, y, 5, floor + 4, s.P, 32), { tone: "mid" });
	s.solid(cylinder(x, y - 10, 2, floor, 2.4, s.P, 16), { crease: "none" });
}

tray();
display();
pendant();
watch();
ruler(
	s,
	{ x: TRAY.x + 70, y: TRAY.y + TRAY.d - 22, w: 100, d: 6, r: 1 },
	floor
);

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
