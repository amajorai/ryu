import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	byDepth,
	knob,
	lamp,
	ruler,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Scoped actions: a peg board of action sockets. Each socket you allow
 * holds a raised peg an agent can pull; every other socket is screwed shut
 * with a blanking plate. The peg the agent is calling now is lit.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const BOARD = { x: -78, y: -36, w: 128, d: 66, r: 5 };
const BOARD_H = 12;
const PEG_H = 24;

type Socket = [number, number, "peg" | "blank" | "lit"];

const SOCKETS: Socket[] = [
	[-58, -18, "peg"],
	[-30, -18, "blank"],
	[-2, -18, "blank"],
	[26, -18, "peg"],
	[-58, 10, "peg"],
	[-30, 10, "blank"],
	[-2, 10, "lit"],
	[26, 10, "blank"],
];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-58, -18, BOARD_H + PEG_H + 6],
]);

benchPlate(s, PLATE);
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BOARD, 4), BOARD_H, s.P, 4), { tone: "faint" });
for (const [x, y, kind] of byDepth(SOCKETS, s, BOARD_H)) {
	if (kind === "blank") {
		s.solid(
			slabOf({ x: x - 9, y: y - 9, w: 18, d: 18, r: 2 }, BOARD_H, 1.6, s.P, 3),
			{
				tone: "lo",
			}
		);
		screws(
			s,
			[
				[x - 5, y - 5],
				[x + 5, y + 5],
			],
			BOARD_H + 1.6,
			1.1
		);
		continue;
	}
	s.line(ring(x, y, 8, BOARD_H, s.P, 28), { tone: "lo" });
	s.solid(cylinder(x, y, 6.5, BOARD_H, 2, s.P, 28), { tone: "lo" });
	s.solid(cylinder(x, y, 4.2, BOARD_H + 2, PEG_H - 4, s.P, 24), {
		lit: kind === "lit",
	});
	s.solid(cylinder(x, y, 6.5, BOARD_H + PEG_H - 2, 4, s.P, 24, 0.6), {
		lit: kind === "lit",
	});
}
// Selector side: the agent picker knob, a status lamp and a scale.
const side = { x: 58, y: -30, w: 26, d: 54, r: 4 };
s.halo(side, 0);
s.solid(slabOf(side, 0, 8, s.P, 4, 0.6));
lamp(s, [side.x + 13, side.y + 10], 8, { radius: 1.6 });
knob(s, [side.x + 13, side.y + 30], 8, 6, 6);
ruler(s, { x: BOARD.x, y: BOARD.y + BOARD.d + 6, w: 100, d: 7, r: 1 });

export const drawing = cardDrawing(s);
