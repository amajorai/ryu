import {
	boxCorners,
	lineOnTop,
	pathOf,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Runbook drafting: a ring binder lying open. Past fixes are filed as a thick
 * stack behind tab dividers on the left; the one-off resolution has just been
 * written up as a new entry (the lit sheet) and clipped onto the rings, ready
 * for the next ticket on the same issue.
 */

const PLATE = { x: -100, y: -56, w: 200, d: 112, r: 8 };
const BOARD_D = 88;
const BOARD_Y = -44;
const LEFT = { x: -88, y: BOARD_Y, w: 76, d: BOARD_D, r: 3 };
const SPINE = { x: -12, y: BOARD_Y, w: 14, d: BOARD_D, r: 1 };
const RIGHT = { x: 2, y: BOARD_Y, w: 76, d: BOARD_D, r: 3 };
const STACK_H = 7;
const RING_X = -5;
const RING_R = 13;
/** Rings rise from the sheet surface, threaded through the punched holes. */
const RING_BASE = 4.2;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-5, 0, 22]]);

function rules(x: number, y: number, z: number, count: number) {
	for (let i = 0; i < count; i++) {
		const yy = y + i * 7;
		const width = [52, 44, 50, 36, 48, 40, 30, 46, 38][i] ?? 40;
		s.line(lineOnTop([x, yy], [x + width, yy], z, s.P), {
			tone: i === 0 ? "mid" : "lo",
		});
	}
}

benchPlate(s, PLATE);
s.halo({ x: LEFT.x, y: BOARD_Y, w: 166, d: BOARD_D, r: 3 }, 0);
s.solid(slabOf(LEFT, 0, 3, s.P, 3, 0.4), { tone: "lo" });
s.solid(slabOf(SPINE, 0, 2, s.P, 2), { tone: "lo" });
s.solid(slabOf(RIGHT, 0, 3, s.P, 3, 0.4), { tone: "lo" });
// Tab dividers peeking out of the back of the filed stack.
for (const tx of [-80, -62, -44]) {
	s.solid(
		slabOf(
			{ x: tx, y: BOARD_Y - 3, w: 12, d: 10, r: 1 },
			3,
			STACK_H - 1,
			s.P,
			2
		),
		{
			tone: "lo",
		}
	);
}
const stack = { x: -84, y: BOARD_Y + 4, w: 68, d: BOARD_D - 8, r: 1 };
s.solid(slabOf(stack, 3, STACK_H, s.P, 2));
s.line(
	lineOnTop(
		[stack.x + 0.5, stack.y + stack.d],
		[stack.x + stack.w, stack.y + stack.d],
		3 + STACK_H / 2,
		s.P
	),
	{ tone: "faint" }
);
rules(stack.x + 8, stack.y + 10, 3 + STACK_H, 9);
// The fresh entry on the right board.
const sheet = { x: 6, y: BOARD_Y + 4, w: 68, d: BOARD_D - 8, r: 1 };
s.solid(slabOf(sheet, 3, 1.2, s.P, 2), { lit: true, crease: "none" });
rules(sheet.x + 10, sheet.y + 10, 4.2, 6);
// Ring mechanism along the spine, rings arching over it.
s.solid(
	slabOf(
		{ x: -10, y: BOARD_Y + 10, w: 10, d: BOARD_D - 20, r: 2 },
		2,
		4,
		s.P,
		3,
		0.4
	)
);
for (const [rx, ry] of byDepth(
	[
		[RING_X, BOARD_Y + 18],
		[RING_X, 0],
		[RING_X, BOARD_Y + BOARD_D - 18],
	] as [number, number][],
	s
)) {
	const arch = Array.from({ length: 17 }, (_, i) => {
		const angle = (i / 16) * Math.PI;
		return s.at([
			rx + RING_R * Math.cos(angle),
			ry,
			RING_BASE + RING_R * 0.7 * Math.sin(angle),
		]);
	});
	s.line(pathOf(arch), { tone: "hi" });
}

export const drawing = cardDrawing(s);
