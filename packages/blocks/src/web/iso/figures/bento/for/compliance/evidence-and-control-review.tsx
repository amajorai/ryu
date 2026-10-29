import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Evidence and control review: a fit gauge. The control's requirements are
 * cut as pockets in a gauge block; each piece of evidence that fits sits in
 * its pocket, and the one pocket still empty (its floor is the lit part)
 * shows what is missing. A loose piece waits in the intake tray behind.
 */

const PLATE = { x: -96, y: -56, w: 192, d: 112, r: 8 };
const GAUGE = { x: -66, y: -16, w: 132, d: 62, r: 5 };
const GAUGE_H = 10;
const PIECE_H = 3;
const TRAY = { x: -60, y: -50, w: 92, d: 26, r: 3 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, GAUGE_H + 8]]);

interface Pocket {
	filled: boolean;
	shape: "box" | "round" | "bar";
	x: number;
	y: number;
}
const POCKETS: Pocket[] = [
	{ x: -36, y: 0, shape: "box", filled: true },
	{ x: 0, y: 0, shape: "round", filled: true },
	{ x: 36, y: 0, shape: "bar", filled: false },
	{ x: -36, y: 28, shape: "round", filled: true },
	{ x: 0, y: 28, shape: "bar", filled: true },
	{ x: 36, y: 28, shape: "box", filled: true },
];

function planFor({ x, y, shape }: Pocket, grow: number) {
	if (shape === "bar") {
		return {
			x: x - 13 - grow,
			y: y - 5 - grow,
			w: 26 + grow * 2,
			d: 10 + grow * 2,
			r: 2,
		};
	}
	const half = 9 + grow;
	return {
		x: x - half,
		y: y - half,
		w: half * 2,
		d: half * 2,
		r: shape === "round" ? half : 2,
	};
}

benchPlate(s, PLATE);
// Intake tray behind, with loose pieces waiting to be checked.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 5, s.P, 3, 0.6), { tone: "lo" });
s.line(planOutline(insetPlan(TRAY, 3), 5, s.P, 2), { tone: "faint" });
s.solid(slabOf({ x: -50, y: -44, w: 18, d: 18, r: 2 }, 5, PIECE_H, s.P, 2));
s.solid(cylinder(-12, -37, 8, 5, PIECE_H, s.P, 32, 0.5));
// The gauge block with its pockets.
s.halo(GAUGE, 0);
s.solid(slabOf(GAUGE, 0, GAUGE_H, s.P, 5, 1));
s.line(planOutline(insetPlan(GAUGE, 4), GAUGE_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[GAUGE.x + 7, GAUGE.y + 7],
		[GAUGE.x + GAUGE.w - 7, GAUGE.y + GAUGE.d - 7],
	],
	GAUGE_H,
	1.3
);
for (const pocket of POCKETS) {
	const rim = planFor(pocket, 1.5);
	s.line(planOutline(rim, GAUGE_H, s.P, pocket.shape === "round" ? 12 : 3), {
		tone: "mid",
	});
	if (!pocket.filled) {
		s.solid(slabOf(planFor(pocket, 0.5), GAUGE_H, 0.4, s.P, 3), {
			lit: true,
			crease: "none",
		});
		continue;
	}
	const piece = planFor(pocket, 0);
	if (pocket.shape === "round") {
		s.solid(cylinder(pocket.x, pocket.y, 9, GAUGE_H, PIECE_H, s.P, 32, 0.5));
	} else {
		s.solid(slabOf(piece, GAUGE_H, PIECE_H, s.P, 3, 0.5));
	}
}

export const drawing = cardDrawing(s);
