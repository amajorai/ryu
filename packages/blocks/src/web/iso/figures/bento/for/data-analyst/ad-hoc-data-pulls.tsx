import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Ad hoc data pulls: a core drill on a column over the warehouse block. A
 * request sets the bit down into the block; the sample it pulled out stands
 * in the holder beside it (the lit core), next to the slip that says how.
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const BLOCK = { x: -78, y: -34, w: 84, d: 66, r: 4 };
const BLOCK_H = 22;
const POST = { x: -42, y: -50, w: 14, d: 12, r: 2 };
const POST_H = 66;
const BIT: [number, number] = [-35, -6];
const HOLDER = { x: 24, y: -30, w: 30, d: 30, r: 4 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-35, -44, 72]]);

benchPlate(s, PLATE);
// Column and its base behind the block.
s.halo(POST, 0);
s.solid(slabOf(POST, 0, POST_H, s.P, 4, 0.8));
// The warehouse block, shelf lines on its top.
s.halo(BLOCK, 0);
s.solid(slabOf(BLOCK, 0, BLOCK_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BLOCK, 5), BLOCK_H, s.P, 4), { tone: "faint" });
for (const y of [-14, 12]) {
	s.line(
		lineOnTop([BLOCK.x + 5, y], [BLOCK.x + BLOCK.w - 5, y], BLOCK_H, s.P),
		{
			tone: "faint",
		}
	);
}
s.line(ring(BIT[0] + 26, BIT[1] + 18, 4.5, BLOCK_H, s.P, 24), { tone: "lo" });
s.line(ring(BIT[0], BIT[1], 6, BLOCK_H, s.P, 28), { tone: "mid" });
// Bit, chuck, motor head and the arm off the column.
s.solid(cylinder(BIT[0], BIT[1], 3.5, BLOCK_H, 16, s.P, 20), { tone: "lo" });
s.solid(cylinder(BIT[0], BIT[1], 6, BLOCK_H + 16, 6, s.P, 24));
s.solid(cylinder(BIT[0], BIT[1], 10, BLOCK_H + 22, 18, s.P, 32, 0.8));
s.solid(
	slabOf(
		{ x: BIT[0] - 6, y: POST.y + 2, w: 12, d: 54, r: 2 },
		POST_H - 6,
		6,
		s.P,
		3,
		0.6
	)
);
screws(s, [[BIT[0], BIT[1]]], POST_H, 1.6);
// Sample holder with the pulled core standing in it.
s.halo(HOLDER, 0);
s.solid(slabOf(HOLDER, 0, 8, s.P, 4, 0.6), { tone: "lo" });
s.solid(cylinder(39, -15, 6, 8, 26, s.P, 28), { lit: true });
s.line(ring(39, -15, 6, 20, s.P, 28), { tone: "lo" });
// The slip with the query on it.
const slip = { x: 18, y: 14, w: 52, d: 30, r: 2 };
s.halo(slip, 0);
s.solid(slabOf(slip, 0, 1.4, s.P, 3), { crease: "none" });
[40, 30, 36, 22].forEach((length, i) => {
	const y = slip.y + 7 + i * 6;
	s.line(lineOnTop([slip.x + 6, y], [slip.x + 6 + length, y], 1.4, s.P), {
		tone: i === 0 ? "mid" : "lo",
	});
});

export const drawing = cardDrawing(s);
