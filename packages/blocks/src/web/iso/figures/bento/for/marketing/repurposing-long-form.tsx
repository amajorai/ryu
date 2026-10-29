import { boxCorners, lineOnTop, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Repurposing long-form: a slicer. The long block (the transcript) rides the
 * bed into a gantry whose blade (the lit part) cuts it; past the blade the
 * cut pieces stand apart in different sizes: clips, quotes, captions and a
 * flat newsletter sheet.
 */

const PLATE = { x: -106, y: -40, w: 212, d: 80, r: 8 };
const BED = { x: -98, y: -16, w: 196, d: 30, r: 3 };
const BED_H = 4;
const LOG = { x: -92, y: -12, w: 70, d: 22, r: 2 };
const LOG_H = 16;
const GANTRY_X = -16;
const BEAM_Z = 34;
const LEG = 5;

// [x, width, height] of each cut piece, nearest to the blade first.
const CUTS: [number, number, number][] = [
	[-6, 12, 16],
	[12, 12, 16],
	[30, 8, 11],
	[44, 8, 11],
	[58, 4, 16],
	[66, 4, 16],
	[76, 18, 2],
];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[GANTRY_X, -26, BEAM_Z + 12],
]);

function post(y: number) {
	s.solid(leg(y));
}

function leg(y: number) {
	return slabOf(
		{ x: GANTRY_X - LEG, y: y - LEG, w: 2 * LEG, d: 2 * LEG, r: 1.5 },
		0,
		BEAM_Z,
		s.P,
		2,
		0.4
	);
}

benchPlate(s, PLATE);
post(-24);
s.halo(BED, 0);
s.solid(slabOf(BED, 0, BED_H, s.P, 4, 0.6), { tone: "lo" });
screws(
	s,
	[
		[BED.x + 5, BED.y + 15],
		[BED.x + BED.w - 5, BED.y + 15],
	],
	BED_H,
	1.2
);
s.solid(slabOf(LOG, BED_H, LOG_H, s.P, 4, 0.6));
for (const y of [-6, -1, 4]) {
	s.line(
		lineOnTop([LOG.x + 6, y], [LOG.x + LOG.w - 6, y], BED_H + LOG_H, s.P),
		{ tone: "faint" }
	);
}
// Blade hanging from the beam, just past the end of the block.
s.solid(
	slabOf(
		{ x: GANTRY_X - 1.5, y: -14, w: 3, d: 26, r: 0.3 },
		BED_H + 6,
		BEAM_Z - BED_H - 6,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
// The cut pieces, far to near along the bed.
for (const [x, w, h] of CUTS) {
	s.solid(slabOf({ x, y: -12, w, d: 22, r: 1 }, BED_H, h, s.P, 2, 0.3), {
		crease: h < 3 ? "none" : "faint",
	});
}
post(22);
s.solid(
	slabOf(
		{ x: GANTRY_X - 7, y: -30, w: 14, d: 58, r: 2 },
		BEAM_Z,
		6,
		s.P,
		3,
		0.6
	)
);
knob(s, [GANTRY_X, -20], BEAM_Z + 6, 3.5, 5);
lamp(s, [GANTRY_X, 18], BEAM_Z + 6, { radius: 1.8 });

export const drawing = cardDrawing(s);
