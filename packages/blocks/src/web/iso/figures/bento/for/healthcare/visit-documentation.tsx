import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Visit documentation: a dictation recorder beside a clipboard. The
 * consultation is on the recorder's tape; the clipboard holds the summary it
 * became, ruled out and clipped, with an empty signature box (the lit part)
 * waiting for the clinician and the pen laid ready beside it.
 */

const PLATE = { x: -104, y: -56, w: 208, d: 112, r: 8 };
const RECORDER = { x: -92, y: -44, w: 64, d: 46, r: 4 };
const REC_H = 14;
const BOARD = { x: -16, y: -46, w: 82, d: 92, r: 4 };
const BOARD_H = 3;
const SHEET = insetPlan(BOARD, 7);
const SHEET_Z = BOARD_H;
const TOP = SHEET_Z + 1.2;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-60, -20, 24]]);

benchPlate(s, PLATE);
// The recorder: two tape reels on its deck, transport keys along the front.
s.halo(RECORDER, 0);
s.solid(slabOf(RECORDER, 0, REC_H, s.P, 6, 0.8));
const window = { x: RECORDER.x + 6, y: RECORDER.y + 5, w: 52, d: 24, r: 3 };
s.solid(slabOf(window, REC_H, 1, s.P, 4), { tone: "lo", crease: "none" });
for (const x of [window.x + 13, window.x + 39]) {
	s.solid(cylinder(x, window.y + 12, 9, REC_H + 1, 2.4, s.P, 36, 0.4));
	s.line(ring(x, window.y + 12, 3, REC_H + 3.4, s.P, 6), { tone: "mid" });
}
s.line(
	lineOnTop(
		[window.x + 13, window.y + 21],
		[window.x + 39, window.y + 21],
		REC_H + 1,
		s.P
	),
	{ tone: "mid" }
);
for (let i = 0; i < 4; i++) {
	s.solid(
		slabOf(
			{ x: RECORDER.x + 8 + i * 10, y: RECORDER.y + 34, w: 8, d: 6, r: 1 },
			REC_H,
			i === 1 ? 1 : 2.4,
			s.P,
			2
		),
		{ tone: i === 1 ? "lo" : "mid" }
	);
}
knob(s, [RECORDER.x + 54, RECORDER.y + 37], REC_H, 3.6, 3);
// The clipboard and the drafted summary on it.
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 6, 0.6));
s.solid(slabOf(SHEET, SHEET_Z, 1.2, s.P, 3), { crease: "none" });
const widths = [52, 60, 44, 58, 36, 54, 40];
widths.forEach((width, i) => {
	const y = SHEET.y + 16 + i * 7.4;
	s.line(lineOnTop([SHEET.x + 6, y], [SHEET.x + 6 + width, y], TOP, s.P), {
		tone: i === 0 ? "mid" : "lo",
	});
});
const sign = { x: SHEET.x + 26, y: SHEET.y + SHEET.d - 15, w: 36, d: 9, r: 1 };
s.solid(slabOf(sign, TOP, 1, s.P, 2), { lit: true, crease: "none" });
// The clip across the top edge of the board.
const clip = { x: BOARD.x + 24, y: BOARD.y - 3, w: 34, d: 13, r: 3 };
s.solid(slabOf(clip, BOARD_H, 4, s.P, 4, 0.6), { tone: "lo" });
s.solid(
	slabOf(
		{ x: clip.x + 9, y: clip.y + 2, w: 16, d: 6, r: 2 },
		BOARD_H + 4,
		3,
		s.P,
		3
	)
);
screws(
	s,
	[
		[clip.x + 4, clip.y + 6.5],
		[clip.x + clip.w - 4, clip.y + 6.5],
	],
	BOARD_H + 4,
	1.2
);
// The pen, laid on the bench beside the board.
const pen = { x: 78, y: -18, w: 6, d: 52, r: 3 };
s.halo(pen, 0);
s.solid(slabOf(pen, 0, 5, s.P, 4, 0.6));
s.solid(slabOf({ x: 78.5, y: -18, w: 5, d: 14, r: 2.5 }, 5, 0.8, s.P, 3), {
	tone: "lo",
	crease: "none",
});

export const drawing = cardDrawing(s);
