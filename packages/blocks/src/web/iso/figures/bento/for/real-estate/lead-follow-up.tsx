import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Lead follow-up: a curbside mailbox whose flag is up (the lit part) because
 * a new inquiry came in. The drafted reply waits in its envelope, and the
 * card file in front, the CRM, already holds the logged card.
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const POST: [number, number] = [-62, -14];
const BOX = { x: -76, y: -42, w: 28, d: 50, r: 3 };
const BOX_Z = 30;
const BOX_H = 18;
const FILE = { x: 10, y: -12, w: 64, d: 46, r: 3 };
const FILE_H = 14;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-48, -30, BOX_Z + BOX_H + 18],
]);

benchPlate(s, PLATE);
// Mailbox: footing, post, box with its front door, flag raised on the side.
s.halo({ x: POST[0] - 10, y: POST[1] - 10, w: 20, d: 20, r: 3 }, 0);
s.solid(
	slabOf(
		{ x: POST[0] - 10, y: POST[1] - 10, w: 20, d: 20, r: 3 },
		0,
		3,
		s.P,
		4
	),
	{ tone: "lo" }
);
screws(
	s,
	[
		[POST[0] - 6, POST[1] + 6],
		[POST[0] + 6, POST[1] - 6],
	],
	3,
	1.2
);
s.solid(
	slabOf(
		{ x: POST[0] - 3, y: POST[1] - 3, w: 6, d: 6, r: 1 },
		3,
		BOX_Z - 3,
		s.P,
		2
	)
);
s.solid(slabOf(BOX, BOX_Z, BOX_H, s.P, 6, 0.6));
s.line(planOutline(insetPlan(BOX, 3), BOX_Z + BOX_H, s.P, 4), {
	tone: "faint",
});
const front = BOX.y + BOX.d;
s.line(
	faceRect(
		s,
		"y",
		front,
		BOX.x + 3,
		BOX.x + BOX.w - 3,
		BOX_Z + 2,
		BOX_Z + BOX_H - 2
	),
	{
		tone: "mid",
	}
);
s.solid(
	cylinder(BOX.x + BOX.w / 2, front + 1, 1.4, BOX_Z + BOX_H - 8, 1.6, s.P, 12),
	{
		tone: "lo",
	}
);
const side = BOX.x + BOX.w;
s.solid(
	slabOf({ x: side, y: -16, w: 1.6, d: 2.4, r: 0.3 }, BOX_Z + 4, 30, s.P, 1)
);
s.solid(
	slabOf({ x: side, y: -30, w: 1.6, d: 14, r: 0.3 }, BOX_Z + 22, 12, s.P, 1),
	{
		lit: true,
	}
);
// The drafted reply: an envelope lying on the bench, flap lines on top.
const ENV = { x: -38, y: 8, w: 40, d: 26, r: 1 };
s.halo(ENV, 0);
s.solid(slabOf(ENV, 0, 2, s.P, 2), { crease: "none" });
s.line(
	lineOnTop(
		[ENV.x + 1, ENV.y + 1],
		[ENV.x + ENV.w / 2, ENV.y + ENV.d * 0.55],
		2,
		s.P
	) +
		lineOnTop(
			[ENV.x + ENV.w / 2, ENV.y + ENV.d * 0.55],
			[ENV.x + ENV.w - 1, ENV.y + 1],
			2,
			s.P
		),
	{ tone: "lo" }
);
// The card file: an open tray of index cards with staggered tabs.
s.halo(FILE, 0);
s.solid(slabOf(FILE, 0, FILE_H, s.P, 6, 0.6));
const well = insetPlan(FILE, 4);
s.line(planOutline(well, FILE_H, s.P, 4), { tone: "lo" });
for (let i = 0; i < 6; i++) {
	const y = well.y + 4 + i * 6;
	const height = i === 5 ? 14 : 10;
	s.solid(
		slabOf(
			{ x: well.x + 3, y, w: well.w - 6, d: 1.4, r: 0.3 },
			FILE_H,
			height,
			s.P,
			1
		),
		{ crease: "none" }
	);
	const tab = well.x + 6 + ((i * 13) % 38);
	s.solid(
		slabOf({ x: tab, y, w: 10, d: 1.4, r: 0.3 }, FILE_H + height, 3, s.P, 1),
		{ tone: "lo", crease: "none" }
	);
}
s.line(faceRect(s, "y", FILE.y + FILE.d, FILE.x + 24, FILE.x + 40, 4, 9), {
	tone: "mid",
});

export const drawing = cardDrawing(s);
