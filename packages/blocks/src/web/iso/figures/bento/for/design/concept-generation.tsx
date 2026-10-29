import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Concept generation: a light table laid out with a contact sheet of six
 * variations from one prompt. The pick is lifted off the glass (the lit
 * tile); a stack of earlier prints waits beside the table, kept at the bench.
 */

const PLATE = { x: -92, y: -56, w: 184, d: 112, r: 8 };
const TABLE = { x: -74, y: -42, w: 110, d: 84, r: 5 };
const TABLE_H = 12;
const TILE_W = 26;
const TILE_D = 30;
const PICK: [number, number] = [1, 0];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, TABLE_H + 8]]);

function tile(column: number, row: number) {
	const plan = {
		x: TABLE.x + 8 + column * (TILE_W + 8),
		y: TABLE.y + 8 + row * (TILE_D + 8),
		w: TILE_W,
		d: TILE_D,
		r: 1.5,
	};
	const lit = column === PICK[0] && row === PICK[1];
	const z = lit ? TABLE_H + 6 : TABLE_H;
	if (lit) {
		s.solid(slabOf(insetPlan(plan, 6), TABLE_H, 6, s.P, 3), {
			tone: "lo",
			crease: "none",
		});
	}
	s.solid(slabOf(plan, z, 1.6, s.P, 3), { lit, crease: "none" });
	const top = z + 1.6;
	// A horizon and a sun: the sketch each variation is built on.
	const ridge = plan.y + plan.d - 10 - column * 2;
	s.line(
		lineOnTop(
			[plan.x + 4, ridge],
			[plan.x + plan.w - 4, ridge - 4 + row * 3],
			top,
			s.P
		),
		{ tone: lit ? "mid" : "lo" }
	);
	s.line(ring(plan.x + plan.w - 8, plan.y + 8, 3 + row, top, s.P, 20), {
		tone: lit ? "mid" : "lo",
	});
}

benchPlate(s, PLATE);
s.halo(TABLE, 0);
s.solid(slabOf(TABLE, 0, TABLE_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(TABLE, 4), TABLE_H, s.P, 4), { tone: "faint" });
const cells = byDepth(
	[0, 1, 2].flatMap((column) =>
		[0, 1].map((row): [number, number] => [column, row])
	),
	s
);
for (const [column, row] of cells) {
	tile(column, row);
}
// A dimmer knob on the table's top corner.
knob(s, [TABLE.x + TABLE.w - 7, TABLE.y + 7], TABLE_H, 3.5, 4);
// Earlier prints, stacked on the bench with a weight on top.
const prints = [
	{ x: 50, y: -26, w: 28, d: 34, r: 2 },
	{ x: 52, y: -22, w: 28, d: 34, r: 2 },
	{ x: 49, y: -18, w: 28, d: 34, r: 2 },
];
s.halo(prints[1] ?? TABLE, 0);
prints.forEach((plan, index) => {
	s.solid(slabOf(plan, index * 2, 2, s.P, 3), {
		tone: index === 2 ? "mid" : "lo",
		crease: "none",
	});
});
s.solid(cylinder(63, -1, 6, 6, 5, s.P, 28, 0.5), { tone: "lo" });
screws(s, [[63, -1]], 11, 1.6);

export const drawing = cardDrawing(s);
