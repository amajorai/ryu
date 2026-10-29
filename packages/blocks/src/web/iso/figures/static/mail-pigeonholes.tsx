import { boxCorners, insetPlan, slabOf } from "../../kit/iso-kit.ts";
import { benchPlate, faceRect, knob, ruler } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Ryu Mail: an inbox per agent. A cabinet of pigeonholes, some holding
 * letters, with one letter (the lit part) sliding into its slot, and a tray of
 * outgoing envelopes in front.
 */

const WIDTH = 640;
const HEIGHT = 420;
const PLATE = { x: -130, y: -80, w: 250, d: 160, r: 8 };
const CAB = { x: -104, y: -70, w: 150, d: 44, r: 3 };
const CAB_H = 104;
const COLS = 5;
const ROWS = 4;
const CELL_W = (CAB.w - 12) / COLS;
const CELL_H = (CAB_H - 18) / ROWS;
const FILLED = new Set(["0,1", "1,3", "2,0", "2,2", "3,4", "0,4", "1,0"]);
const LIT: [number, number] = [1, 2];

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [CAB.x, CAB.y, CAB_H + 4]],
	WIDTH,
	HEIGHT
);
const face = CAB.y + CAB.d;
const cellX = (col: number) => CAB.x + 6 + col * CELL_W;
const cellZ = (row: number) => 10 + (ROWS - 1 - row) * CELL_H;

function letter(col: number, row: number, out: number, lit = false) {
	const x = cellX(col) + 4;
	const z = cellZ(row) + 2;
	const plan = { x, y: face - 6, w: CELL_W - 8, d: 6 + out, r: 0.4 };
	s.solid(slabOf(plan, z, 1.6, s.P, 2), { lit, crease: "none" });
}

function cabinet() {
	s.halo(CAB, 0, 7);
	s.solid(slabOf(insetPlan(CAB, -2), 0, 6, s.P, 4, 0.6), { tone: "lo" });
	s.solid(slabOf(CAB, 6, CAB_H - 6, s.P, 4, 1));
	s.solid(slabOf(insetPlan(CAB, -2), CAB_H, 3, s.P, 4, 0.6));
	for (let row = 0; row < ROWS; row++) {
		for (let col = 0; col < COLS; col++) {
			s.line(
				faceRect(
					s,
					"y",
					face,
					cellX(col) + 1,
					cellX(col) + CELL_W - 1,
					cellZ(row) + 1,
					cellZ(row) + CELL_H - 2
				),
				{
					tone: "mid",
				}
			);
			// Card holder under each hole.
			s.line(
				faceRect(
					s,
					"y",
					face,
					cellX(col) + CELL_W / 2 - 5,
					cellX(col) + CELL_W / 2 + 5,
					cellZ(row) - 1.6,
					cellZ(row) + 0.2
				),
				{
					tone: "faint",
				}
			);
		}
	}
	for (let row = 0; row < ROWS; row++) {
		for (let col = 0; col < COLS; col++) {
			if (FILLED.has(`${row},${col}`)) {
				letter(col, row, 2);
			}
		}
	}
	letter(LIT[1], LIT[0], 16, true);
}

function tray() {
	const plan = { x: -40, y: 18, w: 64, d: 40, r: 3 };
	s.halo(plan, 0, 5);
	s.solid(slabOf(plan, 0, 3, s.P, 4, 0.6));
	for (const [i, lift] of [0, 1.8, 3.6, 5.4].entries()) {
		s.solid(
			slabOf(
				{ x: plan.x + 6 + i * 1.5, y: plan.y + 6 - i, w: 48, d: 26, r: 0.6 },
				3 + lift,
				1.6,
				s.P,
				2
			),
			{
				crease: "none",
			}
		);
	}
	knob(s, [plan.x + plan.w - 6, plan.y + plan.d - 6], 3, 2.6, 3);
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 16, w: 110, d: 7, r: 1 });
cabinet();
tray();

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
