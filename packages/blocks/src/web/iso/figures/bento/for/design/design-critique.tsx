import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
	topTicks,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, ruler } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Design critique: a layout board under inspection. A feeler gauge (the lit
 * part) is pushed into the gutter between two cards to check the spacing, a
 * pin marks a note on the header, and a set square checks the alignment.
 */

const PLATE = { x: -92, y: -56, w: 184, d: 112, r: 8 };
const BOARD = { x: -76, y: -44, w: 112, d: 84, r: 4 };
const BOARD_H = 5;
const HEADER = { x: -68, y: -36, w: 96, d: 18, r: 2 };
const LEFT = { x: -68, y: -10, w: 44, d: 30, r: 2 };
const RIGHT = { x: -16, y: -10, w: 44, d: 30, r: 2 };
const GAP_X = LEFT.x + LEFT.w;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-10, -28, 34]]);

benchPlate(s, PLATE);
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BOARD, 3), BOARD_H, s.P, 4), { tone: "faint" });
// Header block, the tallest in the hierarchy, with a note pin.
s.solid(slabOf(HEADER, BOARD_H, 7, s.P, 3, 0.6));
s.line(planOutline(insetPlan(HEADER, 4), BOARD_H + 7, s.P, 2), {
	tone: "faint",
});
s.solid(cylinder(-10, -28, 1, BOARD_H + 7, 14, s.P, 10), { tone: "lo" });
s.solid(cylinder(-10, -28, 4.5, BOARD_H + 21, 4, s.P, 24, 0.6));
// Two cards with a gutter between them; the gauge sits in it.
s.solid(slabOf(LEFT, BOARD_H, 4, s.P, 3, 0.5));
s.line(planOutline({ x: -62, y: -4, w: 24, d: 8, r: 1 }, BOARD_H + 4, s.P, 2), {
	tone: "lo",
});
const gauge = { x: GAP_X + 1, y: -8, w: 6, d: 30, r: 1 };
s.solid(slabOf(gauge, BOARD_H, 9, s.P, 2, 0.4), { lit: true });
s.solid(
	slabOf({ x: GAP_X - 1, y: 20, w: 10, d: 8, r: 2 }, BOARD_H, 4, s.P, 3),
	{
		tone: "lo",
	}
);
s.solid(slabOf(RIGHT, BOARD_H, 4, s.P, 3, 0.5));
s.line(planOutline({ x: -10, y: -4, w: 24, d: 8, r: 1 }, BOARD_H + 4, s.P, 2), {
	tone: "lo",
});
ruler(s, { x: BOARD.x + 6, y: 30, w: 90, d: 6, r: 1 }, BOARD_H);
// Set square lying on the bench beside the board.
const leg = { x: 48, y: -44, w: 9, d: 84, r: 1.5 };
const foot = { x: 48, y: 31, w: 34, d: 9, r: 1.5 };
s.halo(leg, 0);
s.solid(slabOf(leg, 0, 3, s.P, 3, 0.4));
s.solid(slabOf(foot, 0, 3, s.P, 3, 0.4));
const ticks = topTicks(
	-40,
	28,
	4,
	5,
	leg.x + leg.w - 0.6,
	3,
	[-2, -3.6],
	s.P,
	"y"
);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });

export const drawing = cardDrawing(s);
