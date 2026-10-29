import { boxCorners, lineOnTop, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";
import { openBox } from "./open-box.ts";

/*
 * Claim intake and triage: a sorting bench. New notices of loss wait in the
 * intake stack, ride the back conveyor, and drop into one of three bins whose
 * walls rise with severity. The claim just routed to the tallest bin (the lit
 * folder) is the one a handler reviews first.
 */

const PLATE = { x: -100, y: -54, w: 200, d: 94, r: 8 };
const BELT = { x: -48, y: -44, w: 136, d: 18, r: 3 };
const BELT_H = 8;
const BINS = [
	{ x: -40, h: 12 },
	{ x: 2, h: 18 },
	{ x: 44, h: 26 },
];
const BIN_Y = -16;
const BIN_D = 46;
const BIN_W = 36;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [62, 0, 40]]);

benchPlate(s, PLATE);
// Intake stack: new claim folders waiting at the left.
const intake = { x: -90, y: -40, w: 34, d: 44, r: 3 };
s.halo(intake, 0);
s.solid(slabOf(intake, 0, 4, s.P, 4, 0.6), { tone: "lo" });
for (let i = 0; i < 5; i++) {
	s.solid(
		slabOf(
			{ x: intake.x + 4 + (i % 2), y: intake.y + 4, w: 26, d: 36, r: 1 },
			4 + i * 2.2,
			2.2,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
// Conveyor along the back, a lamp over each bin and the diverter over the
// tallest one.
s.halo(BELT, 0);
s.solid(slabOf(BELT, 0, BELT_H, s.P, 4, 0.6));
s.line(
	lineOnTop(
		[BELT.x + 4, BELT.y + 9],
		[BELT.x + BELT.w - 4, BELT.y + 9],
		BELT_H,
		s.P
	),
	{ tone: "lo" }
);
screws(
	s,
	[
		[BELT.x + 6, BELT.y + 9],
		[BELT.x + BELT.w - 6, BELT.y + 9],
	],
	BELT_H,
	1.3
);
s.solid(
	slabOf({ x: 54, y: BELT.y + 3, w: 20, d: 12, r: 2 }, BELT_H, 8, s.P, 3, 0.4)
);
for (const bin of BINS) {
	lamp(s, [bin.x + 4, BELT.y + 4], BELT_H, { radius: 1.6 });
}
// Severity bins, low to high.
for (const [index, bin] of BINS.entries()) {
	openBox(s, { x: bin.x, y: BIN_Y, w: BIN_W, d: BIN_D, r: 2 }, 0, bin.h, () => {
		if (index === BINS.length - 1) {
			s.solid(
				slabOf(
					{ x: bin.x + 7, y: BIN_Y + 16, w: BIN_W - 14, d: 4, r: 0.6 },
					2,
					bin.h + 12,
					s.P,
					2
				),
				{ lit: true }
			);
		}
		if (index === 0) {
			s.solid(
				slabOf(
					{ x: bin.x + 6, y: BIN_Y + 8, w: BIN_W - 12, d: BIN_D - 16, r: 1 },
					2,
					3,
					s.P,
					2
				),
				{ crease: "none" }
			);
		}
	});
}

export const drawing = cardDrawing(s);
