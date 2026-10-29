import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Postmortem drafts: a report being bound. A paper tape of log lines and a
 * stack of chat slips feed a thick draft under a bulldog clip; its section
 * tabs stand out of the side, the last one (lit) for the action items.
 */

const PLATE = { x: -104, y: -54, w: 208, d: 108, r: 8 };
const COVER = { x: -28, y: -42, w: 82, d: 80, r: 3 };
const STACK = insetPlan(COVER, 3);
const STACK_Z = 3;
const STACK_H = 9;
const ROLL: [number, number] = [-74, -22];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-74, -22, 18],
	[10, -42, 30],
]);

benchPlate(s, PLATE);
// The log tape: a paper roll on a spindle, its tape run toward the draft.
s.halo({ x: ROLL[0] - 14, y: ROLL[1] - 14, w: 28, d: 28, r: 14 }, 0);
s.solid(cylinder(ROLL[0], ROLL[1], 13, 0, 16, s.P, 40, 0.6));
s.line(ring(ROLL[0], ROLL[1], 5, 16, s.P, 24), { tone: "lo" });
s.solid(cylinder(ROLL[0], ROLL[1], 2, 16, 3, s.P, 16), { tone: "lo" });
s.solid(slabOf({ x: -70, y: -10, w: 40, d: 10, r: 0.5 }, 0, 0.8, s.P, 2), {
	crease: "none",
});
for (let i = 0; i < 4; i++) {
	const x = -64 + i * 9;
	s.line(lineOnTop([x, -7], [x + 6, -7], 0.8, s.P), { tone: "lo" });
}
// Chat slips, stacked and fanned.
for (let i = 0; i < 3; i++) {
	const slip = { x: -86 + i * 4, y: 8 + i * 5, w: 32, d: 20, r: 1.5 };
	s.solid(slabOf(slip, i * 1.2, 1.2, s.P, 2), { crease: "none" });
	for (let j = 0; j < 2; j++) {
		const ly = slip.y + 6 + j * 7;
		s.line(
			lineOnTop(
				[slip.x + 5, ly],
				[slip.x + (j ? 18 : 25), ly],
				i * 1.2 + 1.2,
				s.P
			),
			{ tone: i === 2 ? "mid" : "faint" }
		);
	}
}
// The draft: cover board, page stack, top sheet rules.
s.halo(COVER, 0);
s.solid(slabOf(COVER, 0, STACK_Z, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(STACK, STACK_Z, STACK_H, s.P, 3, 0.4));
const top = STACK_Z + STACK_H;
for (let i = 0; i < 6; i++) {
	const y = STACK.y + 18 + i * 9;
	const length = [52, 40, 56, 34, 48, 28][i] ?? 40;
	s.line(lineOnTop([STACK.x + 8, y], [STACK.x + 8 + length, y], top, s.P), {
		tone: i % 2 === 0 ? "mid" : "lo",
	});
}
faceRules(s, "y", STACK.y + STACK.d, STACK.x + 6, top - 2, [60, 60, 60], 2.4);
// Bulldog clip across the head of the draft.
s.solid(
	slabOf({ x: -8, y: COVER.y - 1, w: 42, d: 14, r: 2 }, top, 6, s.P, 3, 0.8)
);
s.line(
	planOutline(
		insetPlan({ x: -8, y: COVER.y - 1, w: 42, d: 14, r: 2 }, 3),
		top + 6,
		s.P,
		2
	),
	{ tone: "faint" }
);
for (const x of [-2, 24]) {
	s.solid(
		slabOf({ x, y: COVER.y - 1, w: 3, d: 3, r: 1 }, top + 6, 10, s.P, 2),
		{ tone: "lo" }
	);
}
s.solid(
	slabOf({ x: -2, y: COVER.y - 1, w: 29, d: 3, r: 1 }, top + 16, 2, s.P, 2),
	{ tone: "lo" }
);
// Section tabs out of the near side; the last marks the action items.
const tabX = COVER.x + COVER.w - 3;
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf(
			{ x: tabX, y: -26 + i * 20, w: 10, d: 12, r: 2 },
			STACK_Z + 2 + i * 2.6,
			1.6,
			s.P,
			2
		),
		{ lit: i === 2, crease: "none" }
	);
}
// The pen lying beside it.
s.solid(slabOf({ x: 76, y: -34, w: 6, d: 54, r: 3 }, 0, 5, s.P, 4, 1));
s.solid(slabOf({ x: 76, y: 20, w: 6, d: 8, r: 2 }, 0, 5, s.P, 4), {
	tone: "lo",
});

export const drawing = cardDrawing(s);
