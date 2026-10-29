import {
	boxCorners,
	corners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../kit/iso-kit.ts";
import { benchPlate, jack, lamp, ruler, screws } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Ryu Connect: hosted tools and skills behind one API. A switchboard: a field
 * of jacks, each a hosted tool, two calls already patched through, and one
 * cord (the lit part) being plugged into its tool.
 */

const WIDTH = 640;
const HEIGHT = 420;
const PLATE = { x: -140, y: -84, w: 260, d: 168, r: 8 };
const BOARD = { x: -110, y: -64, w: 170, d: 92, r: 5 };
const BOARD_H = 14;
const COLS = 9;
const ROWS = 4;
const LEDGE = { x: -110, y: 34, w: 170, d: 20, r: 3 };
const PLUGS = 6;

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [0, 0, 50]],
	WIDTH,
	HEIGHT
);
const jackAt = (col: number, row: number): [number, number] => [
	BOARD.x + 18 + col * 17,
	BOARD.y + 16 + row * 18,
];

function board() {
	s.halo(BOARD, 0);
	s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 5, 1));
	s.line(planOutline(insetPlan(BOARD, 6), BOARD_H, s.P, 3), { tone: "faint" });
	screws(s, corners(BOARD, 4), BOARD_H, 1.2);
	for (let row = 0; row < ROWS; row++) {
		for (let col = 0; col < COLS; col++) {
			const at = jackAt(col, row);
			jack(s, at, BOARD_H);
			if (col % 3 === 0) {
				lamp(s, [at[0] + 6, at[1] - 7], BOARD_H, {
					radius: 1.2,
					lit: row === 1 && col === 6,
				});
			}
		}
	}
}

function ledge() {
	s.halo(LEDGE, 0);
	s.solid(slabOf(LEDGE, 0, 8, s.P, 3, 0.6));
	for (let i = 0; i < PLUGS; i++) {
		const x = LEDGE.x + 20 + i * 26;
		const y = LEDGE.y + LEDGE.d / 2;
		s.solid(cylinder(x, y, 3, 8, 6, s.P, 20));
		s.solid(cylinder(x, y, 1.4, 14, 5, s.P, 12), { crease: "none" });
	}
}

/** A cord from a plug on the ledge to a jack, sagging between them. */
function cord(fromIndex: number, to: [number, number], lit = false, lift = 0) {
	const from: [number, number, number] = [
		LEDGE.x + 20 + fromIndex * 26,
		LEDGE.y + LEDGE.d / 2,
		19,
	];
	const end: [number, number, number] = [to[0], to[1], BOARD_H + 4 + lift];
	const via: [number, number, number][] = [];
	for (let i = 1; i < 10; i++) {
		const t = i / 10;
		via.push([
			from[0] + (end[0] - from[0]) * t,
			from[1] + (end[1] - from[1]) * t,
			from[2] + (end[2] - from[2]) * t + 14 * Math.sin(Math.PI * t),
		]);
	}
	s.wire(from, end, via, { tone: lit ? "hi" : "mid" });
	s.solid(cylinder(end[0], end[1], 2.6, end[2] - 4, 5, s.P, 20), {
		lit,
		tone: lit ? "hi" : "mid",
	});
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 14, w: 130, d: 7, r: 1 });
board();
ledge();
cord(1, jackAt(2, 1));
cord(3, jackAt(5, 3));
const target = jackAt(6, 1);
cord(4, target, true, 16);

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
