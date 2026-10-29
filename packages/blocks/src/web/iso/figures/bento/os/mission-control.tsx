import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, byDepth, knob, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Mission Control: a two-step control console. The raised back deck is a
 * status board with one lamp per chat; finished chats sit dark, and the one
 * still outstanding is the lit lamp. The low front deck carries the knobs and
 * toggle switches you steer them with.
 */

const PLATE = { x: -84, y: -54, w: 168, d: 108, r: 8 };
const BOARD = { x: -66, y: -40, w: 132, d: 46, r: 4 };
const BOARD_H = 26;
const DECK = { x: -66, y: 6, w: 132, d: 32, r: 4 };
const DECK_H = 12;
const COLUMNS = 6;
const ROWS = 3;
const LIT: [number, number] = [4, 1];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, BOARD_H + 8]]);

benchPlate(s, PLATE);
s.halo({ ...BOARD, d: BOARD.d + DECK.d }, 0);
// Raised status board at the back.
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 6, 1));
const face = insetPlan(BOARD, 6);
s.line(planOutline(face, BOARD_H, s.P, 3), { tone: "faint" });
const cells: [number, number, boolean][] = [];
for (let row = 0; row < ROWS; row++) {
	for (let column = 0; column < COLUMNS; column++) {
		const x = face.x + 10 + column * ((face.w - 20) / (COLUMNS - 1));
		const y = face.y + 7 + row * ((face.d - 14) / (ROWS - 1));
		cells.push([x, y, column === LIT[0] && row === LIT[1]]);
	}
}
for (const [x, y, lit] of byDepth(cells, s, BOARD_H)) {
	if (lit) {
		// The outstanding chat: a raised, lit push button.
		s.solid(cylinder(x, y, 5.6, BOARD_H, 1.2, s.P, 24), { tone: "lo" });
		s.solid(cylinder(x, y, 4.4, BOARD_H + 1.2, 4.5, s.P, 24), { lit: true });
	} else {
		lamp(s, [x, y], BOARD_H, { radius: 2.4 });
	}
}
// Low front deck: two knobs and a bank of toggles.
s.solid(slabOf(DECK, 0, DECK_H, s.P, 6, 1));
screws(
	s,
	[
		[DECK.x + 6, DECK.y + DECK.d - 6],
		[DECK.x + DECK.w - 6, DECK.y + DECK.d - 6],
	],
	DECK_H,
	1.4
);
knob(s, [DECK.x + 20, DECK.y + 15], DECK_H, 6, 5);
for (let index = 0; index < 5; index++) {
	const x = DECK.x + 46 + index * 11;
	const y = DECK.y + 15;
	// Toggle: a small raised base with its lever thrown back or forward.
	s.solid(
		slabOf({ x: x - 3.5, y: y - 5, w: 7, d: 10, r: 1 }, DECK_H, 2, s.P, 3, 0.6),
		{
			tone: "lo",
		}
	);
	const tipY = index % 2 === 0 ? y - 2.5 : y + 2.5;
	s.solid(cylinder(x, tipY, 1.6, DECK_H + 2, 4, s.P, 16));
}
knob(s, [DECK.x + DECK.w - 14, DECK.y + 15], DECK_H, 5, 4);

export const drawing = cardDrawing(s);
