import {
	boxCorners,
	corners,
	cylinder,
	dotGrid,
	lineOnTop,
	onTop,
	planOutline,
	ring,
	slabOf,
} from "../../kit/iso-kit.ts";
import { byDepth, knob, ruler, screws } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Agents as a Service: we scope your first agent with you. A drafting table:
 * a blueprint pinned to the board, a T-square across it, a compass, an
 * angle-poise lamp, and the pencil (the lit part) mid-line.
 */

const WIDTH = 640;
const HEIGHT = 440;
const BOARD = { x: -130, y: -84, w: 250, d: 160, r: 4 };
const BOARD_Z = 30;
const BOARD_H = 6;
const PRINT = { x: -100, y: -64, w: 170, d: 112, r: 0.5 };
const TOP = BOARD_Z + BOARD_H;

const s = createSketch(
	[...boxCorners(BOARD, 0, TOP), [BOARD.x + 20, BOARD.y + 10, TOP + 70]],
	WIDTH,
	HEIGHT
);

function legs() {
	s.halo(BOARD, 0, 10);
	for (const [x, y] of byDepth(corners(BOARD, 14), s)) {
		s.solid(cylinder(x, y, 4, 0, BOARD_Z, s.P, 20), { crease: "none" });
	}
}

function board() {
	s.solid(slabOf(BOARD, BOARD_Z, BOARD_H, s.P, 4, 1));
	screws(s, corners(BOARD, 6), TOP, 1.2);
	s.solid(slabOf(PRINT, TOP, 0.4, s.P, 2), { tone: "lo", crease: "none" });
	s.dots(dotGrid(PRINT.x + 6, PRINT.y + 6, 15, 10, 11, TOP + 0.4, s.P), {
		size: 0.35,
		tone: "faint",
	});
	// The plan on the blueprint: three boxes wired in a line.
	const boxes = [
		{ x: PRINT.x + 14, y: PRINT.y + 40, w: 34, d: 24, r: 1 },
		{ x: PRINT.x + 68, y: PRINT.y + 40, w: 34, d: 24, r: 1 },
		{ x: PRINT.x + 122, y: PRINT.y + 40, w: 34, d: 24, r: 1 },
	];
	for (const box of boxes) {
		s.line(planOutline(box, TOP + 0.4, s.P, 2), { tone: "mid" });
	}
	s.line(
		lineOnTop(
			[PRINT.x + 48, PRINT.y + 52],
			[PRINT.x + 68, PRINT.y + 52],
			TOP + 0.4,
			s.P
		),
		{ tone: "mid" }
	);
	s.line(
		lineOnTop(
			[PRINT.x + 102, PRINT.y + 52],
			[PRINT.x + 122, PRINT.y + 52],
			TOP + 0.4,
			s.P
		),
		{ tone: "lo", dotted: true }
	);
	for (const [x, y] of corners(PRINT, 3)) {
		s.solid(cylinder(x, y, 1.6, TOP + 0.4, 1.2, s.P, 12));
	}
}

function tools() {
	// T-square: head against the board's edge, blade across the sheet.
	s.solid(
		slabOf(
			{ x: BOARD.x - 6, y: PRINT.y + 74, w: 8, d: 30, r: 1 },
			BOARD_Z - 4,
			BOARD_H + 8,
			s.P,
			3,
			0.4
		)
	);
	s.solid(
		slabOf(
			{ x: BOARD.x + 2, y: PRINT.y + 82, w: 190, d: 8, r: 0.6 },
			TOP,
			1.2,
			s.P,
			2
		),
		{ crease: "none" }
	);
	ruler(
		s,
		{ x: BOARD.x + 6, y: PRINT.y + 82.5, w: 182, d: 6, r: 0.4 },
		TOP + 1.2
	);
	// Compass, legs spread over a circle it drew.
	const [cx, cy] = [PRINT.x + 140, PRINT.y + 18];
	s.line(ring(cx, cy, 10, TOP + 0.4, s.P, 48), { tone: "lo" });
	s.line(
		onTop(
			[
				[cx, cy],
				[cx + 5, cy - 2],
			],
			TOP + 12,
			s.P
		),
		{ tone: "mid" }
	);
	s.wire(
		[cx, cy, TOP + 0.4],
		[cx + 10, cy, TOP + 0.4],
		[[cx + 5, cy - 2, TOP + 12]],
		{ tone: "mid" }
	);
	// The pencil, mid-line at the end of the dotted link.
	const tip: [number, number, number] = [
		PRINT.x + 112,
		PRINT.y + 52,
		TOP + 0.4,
	];
	s.solid(cylinder(tip[0] + 4, tip[1] - 4, 1.6, TOP + 3, 26, s.P, 12), {
		lit: true,
		crease: "none",
	});
}

function lamp() {
	const base: [number, number] = [BOARD.x + 18, BOARD.y + 14];
	s.solid(cylinder(base[0], base[1], 7, TOP, 3, s.P, 28));
	knob(s, base, TOP + 3, 2.4, 3);
	const elbow: [number, number, number] = [base[0] + 18, base[1] + 6, TOP + 46];
	const head: [number, number, number] = [base[0] + 46, base[1] + 26, TOP + 52];
	s.wire([base[0], base[1], TOP + 6], elbow, [], { tone: "mid" });
	s.wire(elbow, head, [], { tone: "mid" });
	s.solid(cylinder(head[0], head[1], 8, head[2] - 8, 8, s.P, 32, 0.6), {
		tone: "hi",
		crease: "lo",
	});
}

legs();
board();
tools();
lamp();

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
