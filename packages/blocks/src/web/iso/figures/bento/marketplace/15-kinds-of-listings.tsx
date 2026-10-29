import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * 15 kinds of listings: a compositor's type case, five by three pockets, each
 * holding a different kind of piece (pegs, blocks, rings, stacks, tiles). One
 * piece is the kind you are browsing (the lit part).
 */

const PLATE = { x: -100, y: -58, w: 200, d: 116, r: 8 };
const CASE = { x: -86, y: -46, w: 172, d: 92, r: 5 };
const CASE_H = 8;
const COLS = 5;
const ROWS = 3;
const GAP = 4;
const CELL_W = (CASE.w - GAP * (COLS + 1)) / COLS;
const CELL_D = (CASE.d - GAP * (ROWS + 1)) / ROWS;
const LIT = 7;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, CASE_H + 20]]);

benchPlate(s, PLATE);
s.halo(CASE, 0);
s.solid(slabOf(CASE, 0, CASE_H, s.P, 6, 0.8));

type Piece = (cx: number, cy: number, z: number, lit: boolean) => void;

const pieces: Piece[] = [
	// Tall peg.
	(cx, cy, z, lit) => s.solid(cylinder(cx, cy, 4, z, 16, s.P, 24), { lit }),
	// Low block.
	(cx, cy, z, lit) =>
		s.solid(
			slabOf({ x: cx - 9, y: cy - 6, w: 18, d: 12, r: 2 }, z, 6, s.P, 3),
			{ lit }
		),
	// Ring.
	(cx, cy, z, lit) => {
		s.solid(cylinder(cx, cy, 9, z, 3, s.P, 36), { lit });
		s.line(ring(cx, cy, 5, z + 3, s.P, 28), { tone: "lo" });
	},
	// Stack of three tiles.
	(cx, cy, z, lit) => {
		for (let i = 0; i < 3; i++) {
			s.solid(
				slabOf(
					{ x: cx - 8, y: cy - 7, w: 16, d: 14, r: 1.5 },
					z + i * 2.4,
					2,
					s.P,
					3
				),
				{
					lit: lit && i === 2,
					crease: "none",
				}
			);
		}
	},
	// Tower block.
	(cx, cy, z, lit) =>
		s.solid(
			slabOf({ x: cx - 5, y: cy - 5, w: 10, d: 10, r: 1.5 }, z, 14, s.P, 3),
			{ lit }
		),
	// Puck with a cap.
	(cx, cy, z, lit) => {
		s.solid(cylinder(cx, cy, 8, z, 4, s.P, 32), { lit });
		s.solid(cylinder(cx, cy, 3, z + 4, 4, s.P, 20), { tone: "lo" });
	},
	// Two pegs.
	(cx, cy, z, lit) => {
		s.solid(cylinder(cx - 4, cy - 2, 2.6, z, 10, s.P, 20), { lit });
		s.solid(cylinder(cx + 4, cy + 2, 2.6, z, 10, s.P, 20), { lit });
	},
	// Wide disc.
	(cx, cy, z, lit) =>
		s.solid(cylinder(cx, cy, 10, z, 3, s.P, 40, 0.5), { lit }),
	// Bar.
	(cx, cy, z, lit) =>
		s.solid(
			slabOf({ x: cx - 11, y: cy - 2.5, w: 22, d: 5, r: 1 }, z, 5, s.P, 2),
			{ lit }
		),
	// Stepped block.
	(cx, cy, z, lit) => {
		s.solid(
			slabOf({ x: cx - 9, y: cy - 6, w: 18, d: 12, r: 1.5 }, z, 4, s.P, 3),
			{ lit }
		);
		s.solid(
			slabOf({ x: cx - 4, y: cy - 4, w: 8, d: 8, r: 1 }, z + 4, 6, s.P, 3),
			{ lit }
		);
	},
	// Short fat peg.
	(cx, cy, z, lit) => s.solid(cylinder(cx, cy, 6, z, 9, s.P, 28, 0.6), { lit }),
	// Flat square tile.
	(cx, cy, z, lit) =>
		s.solid(
			slabOf({ x: cx - 8, y: cy - 8, w: 16, d: 16, r: 3 }, z, 2.4, s.P, 4),
			{ lit }
		),
	// Knob on a collar.
	(cx, cy, z, lit) => {
		s.solid(cylinder(cx, cy, 6, z, 2, s.P, 28), { tone: "lo" });
		s.solid(cylinder(cx, cy, 4, z + 2, 8, s.P, 24), { lit });
	},
	// Upright card.
	(cx, cy, z, lit) =>
		s.solid(
			slabOf({ x: cx - 9, y: cy - 1.5, w: 18, d: 3, r: 0.5 }, z, 12, s.P, 2),
			{ lit }
		),
	// Three beads in a row.
	(cx, cy, z, lit) => {
		for (let i = 0; i < 3; i++) {
			s.solid(cylinder(cx - 7 + i * 7, cy, 2.6, z, 4, s.P, 18), { lit });
		}
	},
];

// Pockets back to front so nearer pieces cover farther ones.
const cells: Array<{ col: number; row: number }> = [];
for (let row = 0; row < ROWS; row++) {
	for (let col = 0; col < COLS; col++) {
		cells.push({ col, row });
	}
}
const depth = ({ col, row }: { col: number; row: number }) =>
	col * (CELL_W + GAP) + row * (CELL_D + GAP);
cells.sort((a, b) => depth(a) - depth(b));
for (const { col, row } of cells) {
	const pocket = {
		x: CASE.x + GAP + col * (CELL_W + GAP),
		y: CASE.y + GAP + row * (CELL_D + GAP),
		w: CELL_W,
		d: CELL_D,
		r: 2,
	};
	const index = row * COLS + col;
	s.line(planOutline(pocket, CASE_H, s.P, 3), { tone: "lo" });
	s.line(planOutline(insetPlan(pocket, 1.4), CASE_H, s.P, 3), {
		tone: "faint",
	});
	pieces[index]?.(
		pocket.x + pocket.w / 2,
		pocket.y + pocket.d / 2,
		CASE_H,
		index === LIT
	);
}

screws(
	s,
	[
		[CASE.x + 2, CASE.y + 2],
		[CASE.x + CASE.w - 2, CASE.y + CASE.d - 2],
	],
	CASE_H,
	1.2
);

export const drawing = cardDrawing(s);
