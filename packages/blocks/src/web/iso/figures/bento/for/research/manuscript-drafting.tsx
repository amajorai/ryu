import { boxCorners, cylinder, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, faceRules, knob } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Manuscript drafting: a typewriter beside a stack of note cards. The notes
 * and sources go in at the side; the draft comes out on the sheet rolled
 * into the platen (the lit page), a first pass that is still yours to edit.
 */

const PLATE = { x: -100, y: -56, w: 200, d: 112, r: 8 };
const BODY = { x: -56, y: -30, w: 110, d: 62, r: 6 };
const BODY_H = 12;
const DECK = { x: -50, y: -34, w: 98, d: 16, r: 4 };
const PAPER = { x: -30, y: -34, w: 56, d: 1.4, r: 0.3 };
const PAPER_Z = BODY_H + 4;
const PAPER_H = 34;
const NOTES = { x: 62, y: -30, w: 30, d: 40, r: 2 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[PAPER.x, PAPER.y, PAPER_Z + PAPER_H + 2],
]);

benchPlate(s, PLATE);
// Body of the machine with its stepped keyboard well.
s.halo(BODY, 0);
s.solid(slabOf(BODY, 0, BODY_H, s.P, 6, 0.8));
// The sheet rises out from behind the platen.
s.solid(slabOf(PAPER, PAPER_Z, PAPER_H, s.P, 2), { lit: true, crease: "none" });
faceRules(
	s,
	"y",
	PAPER.y + PAPER.d,
	PAPER.x + 6,
	PAPER_Z + PAPER_H - 6,
	[40, 34, 42, 26],
	4
);
// Carriage deck and the platen roller with its two knobs.
s.solid(slabOf(DECK, BODY_H - 4, 8, s.P, 4, 0.6), { tone: "lo" });
s.solid(
	slabOf({ x: -40, y: -32, w: 78, d: 10, r: 5 }, BODY_H + 2, 8, s.P, 8, 0.6)
);
knob(s, [-48, -27], BODY_H + 4, 4, 6);
knob(s, [44, -27], BODY_H + 4, 4, 6);
// Three rows of keys, back to front, each row a step lower.
const keys: [number, number, number][] = [];
for (let row = 0; row < 3; row++) {
	for (let k = 0; k < 8 - row; k++) {
		keys.push([-38 + row * 5 + k * 10.5, -8 + row * 11, BODY_H]);
	}
}
for (const [x, y, z] of byDepth(keys, s)) {
	s.solid(cylinder(x, y, 3.4, z, 3, s.P, 20, 0.3), { tone: "lo" });
}
s.solid(
	slabOf({ x: -26, y: 24, w: 48, d: 5, r: 2 }, BODY_H, 2.5, s.P, 4, 0.3),
	{
		tone: "lo",
	}
);
// Note cards at the side, the inputs to the draft.
s.halo(NOTES, 0);
for (let i = 0; i < 7; i++) {
	s.solid(
		slabOf(
			{ ...NOTES, x: NOTES.x + (i % 2), y: NOTES.y + i * 0.8 },
			i * 2,
			1.6,
			s.P,
			2
		),
		{ crease: "none" }
	);
}

export const drawing = cardDrawing(s);
