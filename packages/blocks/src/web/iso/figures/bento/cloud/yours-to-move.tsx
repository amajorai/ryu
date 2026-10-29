import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	byDepth,
	faceRules,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Yours to move: the node rides on a cart, not bolted into the hall. Grab
 * the push handle (the lit grip) and wheel it wherever you want to run it.
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const DECK = { x: -60, y: -36, w: 124, d: 72, r: 4 };
const DECK_Z = 14;
const DECK_H = 5;
const HANDLE_X = -54;
const HANDLE_TOP = 64;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[HANDLE_X, -30, HANDLE_TOP + 4],
	[HANDLE_X, 30, HANDLE_TOP + 4],
]);

function caster(x: number, y: number) {
	s.solid(slabOf({ x: x - 5, y: y - 2.5, w: 10, d: 5, r: 2.4 }, 0, 9, s.P, 4), {
		tone: "lo",
	});
	s.solid(slabOf({ x: x - 3, y: y - 4, w: 6, d: 8, r: 1 }, 5, 4, s.P, 2));
	s.solid(cylinder(x, y, 3, 9, DECK_Z - 9, s.P, 20));
}

function upright(y: number) {
	s.solid(
		slabOf(
			{ x: HANDLE_X - 2, y: y - 2, w: 4, d: 4, r: 1 },
			DECK_Z + DECK_H,
			HANDLE_TOP - DECK_Z - DECK_H,
			s.P,
			2
		)
	);
}

benchPlate(s, PLATE);
s.halo(DECK, 0, 7);
for (const [x, y] of byDepth(
	[
		[DECK.x + 10, DECK.y + 10],
		[DECK.x + 10, DECK.y + DECK.d - 10],
		[DECK.x + DECK.w - 10, DECK.y + 10],
		[DECK.x + DECK.w - 10, DECK.y + DECK.d - 10],
	] as [number, number][],
	s
)) {
	caster(x, y);
}
s.solid(slabOf(DECK, DECK_Z, DECK_H, s.P, 4, 0.6));
const deckTop = DECK_Z + DECK_H;
s.line(planOutline(insetPlan(DECK, 4), deckTop, s.P, 2), { tone: "faint" });
// Push handle at the back: two uprights, a bar and the grip.
upright(-28);
s.solid(
	slabOf({ x: HANDLE_X - 3, y: -32, w: 6, d: 64, r: 2 }, HANDLE_TOP, 4, s.P, 3)
);
s.solid(
	slabOf(
		{ x: HANDLE_X - 3.5, y: -16, w: 7, d: 32, r: 3 },
		HANDLE_TOP - 0.5,
		5,
		s.P,
		4
	),
	{ lit: true }
);
upright(28);
// The node, strapped to the deck.
const node = { x: -40, y: -26, w: 84, d: 52, r: 4 };
const NODE_H = 26;
s.halo(node, deckTop);
s.solid(slabOf(node, deckTop, NODE_H, s.P, 6, 0.8));
const top = deckTop + NODE_H;
s.line(planOutline(insetPlan(node, 4), top, s.P, 3), { tone: "faint" });
faceRules(s, "y", node.y + node.d, node.x + 10, top - 7, [40, 40, 40], 4);
lamp(s, [node.x + node.w - 10, node.y + 10], top, { radius: 1.8 });
screws(
	s,
	[
		[node.x + 10, node.y + node.d - 8],
		[node.x + node.w - 10, node.y + node.d - 8],
	],
	top,
	1.4
);
// Strap over the node, buckled on its near side.
s.solid(
	slabOf({ x: 10, y: node.y - 1, w: 6, d: node.d + 2, r: 0.5 }, top, 1, s.P, 2),
	{ tone: "lo" }
);
s.solid(
	slabOf(
		{ x: 9, y: node.y + node.d, w: 8, d: 1.5, r: 0.4 },
		deckTop + 6,
		8,
		s.P,
		2
	),
	{
		tone: "lo",
	}
);

export const drawing = cardDrawing(s);
