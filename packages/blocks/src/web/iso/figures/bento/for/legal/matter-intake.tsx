import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	radialTicks,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Matter intake: an intake box takes the inbound matter through its top slot
 * (the lit envelope), drops it out of the side chute, and lays out a brief on the clipboard beside it, three
 * sections with a check box each: issues, deadlines, next steps. The desk
 * timer stands for the deadlines it has set.
 */

const PLATE = { x: -98, y: -54, w: 196, d: 108, r: 8 };
const BOX = { x: -86, y: -2, w: 46, d: 46, r: 4 };
const BOX_H = 32;
const BOARD = { x: -16, y: -40, w: 58, d: 74, r: 3 };
const BOARD_H = 3;
const TIMER: [number, number] = [68, -18];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[BOX.x + 25, BOX.y + 23, BOX_H + 16],
]);

benchPlate(s, PLATE);
// Intake box with the matter going in through the slot on top.
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BOX, 5), BOX_H, s.P, 4), { tone: "faint" });
const SLOT_Y = BOX.y + 20;
s.line(
	planOutline(
		{ x: BOX.x + 8, y: SLOT_Y - 2, w: 34, d: 4, r: 1 },
		BOX_H,
		s.P,
		2
	),
	{
		tone: "mid",
	}
);
s.solid(
	slabOf(
		{ x: BOX.x + 10, y: SLOT_Y - 1, w: 30, d: 2, r: 0.4 },
		BOX_H,
		14,
		s.P,
		2
	),
	{
		lit: true,
	}
);
lamp(s, [BOX.x + BOX.w - 8, BOX.y + BOX.d - 8], BOX_H, { radius: 1.8 });
s.line(faceRect(s, "x", BOX.x + BOX.w, BOX.y + 8, BOX.y + BOX.d - 8, 6, 14), {
	tone: "lo",
});
s.solid(
	slabOf(
		{ x: BOX.x + BOX.w, y: BOX.y + 6, w: 12, d: BOX.d - 12, r: 1.5 },
		0,
		4,
		s.P,
		3,
		0.4
	),
	{
		tone: "lo",
	}
);
// The brief on a clipboard.
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 4, 0.6));
const SHEET = insetPlan(BOARD, 5);
s.solid(
	slabOf({ ...SHEET, y: SHEET.y + 6, d: SHEET.d - 6 }, BOARD_H, 1, s.P, 2),
	{ crease: "none" }
);
const top = BOARD_H + 1;
for (let i = 0; i < 3; i++) {
	const y = SHEET.y + 16 + i * 18;
	s.line(
		planOutline(
			{ x: SHEET.x + 5, y: y - 2.5, w: 5, d: 5, r: 0.8 },
			top,
			s.P,
			2
		),
		{
			tone: "mid",
		}
	);
	s.line(lineOnTop([SHEET.x + 14, y], [SHEET.x + 40, y], top, s.P), {
		tone: "mid",
	});
	s.line(lineOnTop([SHEET.x + 14, y + 6], [SHEET.x + 32, y + 6], top, s.P), {
		tone: "lo",
	});
}
const CLIP = { x: BOARD.x + 17, y: BOARD.y + 2, w: 24, d: 10, r: 2 };
s.solid(slabOf(CLIP, BOARD_H, 4, s.P, 3, 0.6), { tone: "lo" });
s.solid(
	cylinder(BOARD.x + BOARD.w / 2, BOARD.y + 7, 3, BOARD_H + 4, 2, s.P, 20)
);
// Desk timer for the deadlines.
s.halo({ x: TIMER[0] - 16, y: TIMER[1] - 16, w: 32, d: 32, r: 16 }, 0);
s.solid(cylinder(TIMER[0], TIMER[1], 15, 0, 12, s.P, 40, 0.8));
s.line(ring(TIMER[0], TIMER[1], 12, 12, s.P, 40), { tone: "lo" });
const ticks = radialTicks(TIMER[0], TIMER[1], 11, 24, 6, 12, [2, 4], s.P);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
s.line(lineOnTop(TIMER, [TIMER[0] + 6, TIMER[1] - 6], 12.5, s.P), {
	tone: "hi",
});
s.solid(cylinder(TIMER[0], TIMER[1], 2.5, 12, 2, s.P, 16), { tone: "lo" });
screws(s, [[TIMER[0], TIMER[1] + 26]], 0, 1.4);

export const drawing = cardDrawing(s);
