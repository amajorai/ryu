import {
	boxCorners,
	cylinder,
	lineOnTop,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Onboarding prep: the new hire's welcome kit, packed in an open crate. A
 * laptop, a mug and the first-week checklist on its clipboard, with the
 * badge (the lit part) laid on top, ready for day one.
 */

const PLATE = { x: -96, y: -52, w: 192, d: 104, r: 8 };
const CRATE = { x: -80, y: -42, w: 150, d: 84, r: 3 };
const WALL = 4;
const WALL_H = 10;
const LAPTOP = { x: -70, y: -30, w: 62, d: 46, r: 3 };
const BOARD = { x: 6, y: -32, w: 40, d: 54, r: 2 };
const MUG: [number, number] = [-36, 28];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-36, 28, 22]]);

const wall = (x: number, y: number, w: number, d: number) =>
	s.solid(slabOf({ x, y, w, d, r: 1 }, 2, WALL_H - 2, s.P, 2, 0.4));

benchPlate(s, PLATE);
s.halo(CRATE, 0);
s.solid(slabOf(CRATE, 0, 2, s.P, 3, 0.4), { tone: "lo" });
wall(CRATE.x, CRATE.y, CRATE.w, WALL);
wall(CRATE.x, CRATE.y + WALL, WALL, CRATE.d - 2 * WALL);
// Laptop: base, hinge barrel at the back, and the closed lid set back from
// the front lip.
s.solid(slabOf(LAPTOP, 2, 4, s.P, 3, 0.4));
s.solid(
	slabOf(
		{ x: LAPTOP.x + 6, y: LAPTOP.y - 2, w: LAPTOP.w - 12, d: 4, r: 2 },
		4,
		5,
		s.P,
		2,
		0.4
	),
	{ tone: "lo" }
);
s.solid(
	slabOf(
		{ x: LAPTOP.x + 1, y: LAPTOP.y, w: LAPTOP.w - 2, d: LAPTOP.d - 5, r: 3 },
		6,
		3,
		s.P,
		3,
		0.4
	),
	{ tone: "lo" }
);
s.line(
	lineOnTop(
		[LAPTOP.x + LAPTOP.w / 2 - 8, LAPTOP.y + LAPTOP.d - 2.5],
		[LAPTOP.x + LAPTOP.w / 2 + 8, LAPTOP.y + LAPTOP.d - 2.5],
		6,
		s.P
	),
	{ tone: "mid" }
);
s.solid(
	cylinder(
		LAPTOP.x + LAPTOP.w / 2,
		LAPTOP.y + (LAPTOP.d - 5) / 2,
		4,
		9,
		0.6,
		s.P,
		20
	),
	{
		crease: "none",
	}
);
// Divider between the laptop bay and the clipboard bay.
wall(-2, CRATE.y + WALL, WALL, CRATE.d - 2 * WALL);
// Clipboard with the first-week checklist and the badge on top.
s.solid(slabOf(BOARD, 2, 2, s.P, 3, 0.4), { tone: "lo" });
const sheet = {
	x: BOARD.x + 3,
	y: BOARD.y + 8,
	w: BOARD.w - 6,
	d: BOARD.d - 11,
	r: 1,
};
s.solid(slabOf(sheet, 4, 0.8, s.P, 2), { crease: "none" });
for (let i = 0; i < 6; i++) {
	const y = sheet.y + 5 + i * 6.5;
	s.line(lineOnTop([sheet.x + 4, y], [sheet.x + 6, y], 4.8, s.P), {
		tone: "mid",
	});
	s.line(
		lineOnTop([sheet.x + 9, y], [sheet.x + 26 - (i % 3) * 4, y], 4.8, s.P),
		{
			tone: "lo",
		}
	);
}
s.solid(
	slabOf(
		{ x: BOARD.x + 10, y: BOARD.y + 2, w: 20, d: 8, r: 2 },
		4,
		4,
		s.P,
		3,
		0.6
	)
);
const badge = { x: 18, y: 0, w: 24, d: 18, r: 2 };
s.solid(slabOf(badge, 4.8, 1.6, s.P, 3), { lit: true });
s.line(ring(badge.x + 5, badge.y + badge.d / 2, 2, 6.4, s.P, 16), {
	tone: "lo",
});
// Right and front walls close the crate.
wall(CRATE.x + CRATE.w - WALL, CRATE.y + WALL, WALL, CRATE.d - 2 * WALL);
// The mug, standing in front of the laptop.
s.solid(cylinder(MUG[0], MUG[1], 9, 2, 18, s.P, 32, 0.6));
s.line(ring(MUG[0], MUG[1], 7.2, 20, s.P, 32), { tone: "lo" });
s.solid(
	slabOf({ x: MUG[0] + 8, y: MUG[1] - 1.5, w: 5, d: 3, r: 1 }, 7, 9, s.P, 2),
	{ tone: "lo" }
);
wall(CRATE.x, CRATE.y + CRATE.d - WALL, CRATE.w, WALL);
screws(
	s,
	[
		[CRATE.x + 6, CRATE.y + CRATE.d - 2],
		[CRATE.x + CRATE.w - 6, CRATE.y + CRATE.d - 2],
	],
	WALL_H,
	1.2
);

export const drawing = cardDrawing(s);
