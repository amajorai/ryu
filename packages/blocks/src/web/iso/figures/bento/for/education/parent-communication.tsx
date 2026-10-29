import {
	boxCorners,
	cylinder,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Parent communication: a mailbox on a post with its flag raised (the lit
 * part): the progress notes are drafted and waiting for staff to send. The
 * week's newsletter envelopes are stacked on the plate beside it.
 */

const PLATE = { x: -58, y: -36, w: 136, d: 82, r: 8 };
const BOX = { x: -40, y: -20, w: 64, d: 30, r: 3 };
const POST_H = 34;
const BOX_H = 26;
const TOP = POST_H + BOX_H;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners(BOX, 0, TOP + 6),
	[14, 12, TOP + 12],
]);

benchPlate(s, PLATE);
// Post on a square foot.
const foot = { x: -24, y: -18, w: 26, d: 26, r: 2 };
s.halo(foot, 0);
s.solid(slabOf(foot, 0, 4, s.P, 3, 0.6), { tone: "lo" });
screws(
	s,
	[
		[-20, -14],
		[-2, 4],
	],
	4,
	1.3
);
s.solid(slabOf({ x: -16, y: -10, w: 10, d: 10, r: 1 }, 4, POST_H - 4, s.P, 2));
// The box with its door on the near end.
s.solid(slabOf(BOX, POST_H, BOX_H, s.P, 4, 1));
s.solid(
	slabOf(
		{ x: BOX.x + 2, y: BOX.y + 3, w: BOX.w - 4, d: BOX.d - 6, r: 6 },
		TOP,
		4,
		s.P,
		6,
		0.6
	),
	{
		tone: "lo",
	}
);
const end = BOX.x + BOX.w;
s.line(
	faceRect(s, "x", end, BOX.y + 4, BOX.y + BOX.d - 4, POST_H + 3, TOP - 3),
	{
		tone: "lo",
	}
);
s.solid(cylinder(end + 1.5, BOX.y + BOX.d / 2, 2, TOP - 12, 3, s.P, 16), {
	tone: "lo",
});
// The raised flag on the near side, on a pivot.
const side = BOX.y + BOX.d;
s.solid(
	slabOf(
		{ x: 4, y: side, w: 3, d: 2.5, r: 0.4 },
		POST_H + 6,
		TOP - POST_H + 4,
		s.P,
		2
	)
);
s.solid(slabOf({ x: 7, y: side, w: 14, d: 2.5, r: 0.4 }, TOP, 10, s.P, 2), {
	lit: true,
});
s.solid(cylinder(5.5, side + 3, 2.2, POST_H + 8, 1.5, s.P, 16));
// A stack of envelopes.
for (let i = 0; i < 3; i++) {
	const env = { x: 30 + i * 2, y: 14 - i * 2, w: 38, d: 26, r: 1 };
	s.solid(slabOf(env, i * 2.2, 2, s.P, 2), { crease: "none" });
	if (i === 2) {
		const z = i * 2.2 + 2;
		s.line(
			lineOnTop([env.x, env.y], [env.x + env.w / 2, env.y + 12], z, s.P) +
				lineOnTop(
					[env.x + env.w / 2, env.y + 12],
					[env.x + env.w, env.y],
					z,
					s.P
				),
			{ tone: "lo" }
		);
	}
}

export const drawing = cardDrawing(s);
