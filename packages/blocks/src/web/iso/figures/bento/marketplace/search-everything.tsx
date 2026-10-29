import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, knob } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Search everything: a card-catalogue cabinet holding the whole marketplace,
 * with one reading lens on a swing arm over its top. A single lens reaches
 * every drawer; the drawer it found is pulled open (the lit part).
 */

const PLATE = { x: -80, y: -50, w: 160, d: 100, r: 8 };
const CAB = { x: -46, y: -40, w: 86, d: 58, r: 4 };
const CAB_H = 46;
const COLS = 3;
const ROWS = 3;
const cellW = (CAB.w - 8) / COLS;
const cellH = (CAB_H - 8) / ROWS;
const cellD = (CAB.d - 8) / 2;
const front = CAB.y + CAB.d;
const side = CAB.x + CAB.w;
// The found drawer: middle column, middle row, pulled toward the viewer.
const found = CAB.x + 4 + cellW;
const foundZ = 4 + cellH;
const PULL = 16;
const CX = found + cellW / 2;
const POST_Y = CAB.y + 8;
const LENS_R = 11;
const LENS_Y = front + 8;
const ARM_Z = CAB_H + 18;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CX, POST_Y, ARM_Z + 5],
	[CX, LENS_Y, ARM_Z + 3],
]);

benchPlate(s, PLATE);
s.halo(CAB, 0);
s.solid(slabOf(CAB, 0, CAB_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(CAB, 4), CAB_H, s.P, 4), { tone: "faint" });

// Drawer fronts on both visible faces, each with a pull.
for (let row = 0; row < ROWS; row++) {
	const z0 = 4 + row * cellH;
	for (let col = 0; col < COLS; col++) {
		const x0 = CAB.x + 4 + col * cellW;
		s.line(
			faceRect(s, "y", front, x0 + 1, x0 + cellW - 1, z0 + 1, z0 + cellH - 1),
			{ tone: "lo" }
		);
		s.line(
			faceRect(
				s,
				"y",
				front,
				x0 + cellW / 2 - 3,
				x0 + cellW / 2 + 3,
				z0 + cellH / 2 - 0.8,
				z0 + cellH / 2 + 0.8
			),
			{ tone: "mid" }
		);
	}
	for (let col = 0; col < 2; col++) {
		const y0 = CAB.y + 4 + col * cellD;
		s.line(
			faceRect(s, "x", side, y0 + 1, y0 + cellD - 1, z0 + 1, z0 + cellH - 1),
			{ tone: "lo" }
		);
		s.line(
			faceRect(
				s,
				"x",
				side,
				y0 + cellD / 2 - 3,
				y0 + cellD / 2 + 3,
				z0 + cellH / 2 - 0.8,
				z0 + cellH / 2 + 0.8
			),
			{ tone: "mid" }
		);
	}
}

// The found drawer, pulled out: an open box with index cards standing in it,
// then its front panel with a pull (the lit part).
const bodyZ = foundZ + 2;
const bodyH = cellH - 5;
s.solid(
	slabOf(
		{ x: found + 2.5, y: front - 4, w: cellW - 5, d: PULL + 2, r: 1 },
		bodyZ,
		bodyH,
		s.P,
		2
	),
	{ tone: "lo" }
);
for (const y of [front + 2, front + 6, front + 10]) {
	s.solid(
		slabOf(
			{ x: found + 4.5, y, w: cellW - 9, d: 1, r: 0 },
			bodyZ + bodyH - 1,
			3,
			s.P,
			1
		),
		{ crease: "none" }
	);
}
const panelY = front + PULL - 2;
s.solid(
	slabOf(
		{ x: found + 1, y: panelY, w: cellW - 2, d: 2.4, r: 0.6 },
		foundZ + 1,
		cellH - 2,
		s.P,
		2
	),
	{ lit: true }
);
s.line(
	faceRect(
		s,
		"y",
		panelY + 2.4,
		CX - 3,
		CX + 3,
		foundZ + cellH / 2 - 0.8,
		foundZ + cellH / 2 + 0.8
	),
	{ tone: "mid" }
);

// The swing arm: a post at the back of the top, an arm out over the found
// drawer, and the reading lens hanging at its end.
s.solid(cylinder(CX, POST_Y, 6, CAB_H, 2, s.P, 28), { tone: "lo" });
s.solid(cylinder(CX, POST_Y, 3.4, CAB_H + 2, ARM_Z - CAB_H - 2, s.P, 24));
s.solid(
	slabOf(
		{ x: CX - 3, y: POST_Y - 3, w: 6, d: LENS_Y - LENS_R + 6 - POST_Y, r: 2 },
		ARM_Z,
		3,
		s.P,
		3
	)
);
s.solid(cylinder(CX, POST_Y, 4.2, ARM_Z + 3, 1.6, s.P, 24), { tone: "lo" });
s.solid(cylinder(CX, LENS_Y, LENS_R, ARM_Z, 3, s.P, 44, 0.6));
s.line(ring(CX, LENS_Y, LENS_R - 3, ARM_Z + 3, s.P, 44), { tone: "lo" });
s.line(ring(CX, LENS_Y, LENS_R - 6, ARM_Z + 3, s.P, 36), { tone: "faint" });

knob(s, [62, 30], 0, 6, 6);

export const drawing = cardDrawing(s);
