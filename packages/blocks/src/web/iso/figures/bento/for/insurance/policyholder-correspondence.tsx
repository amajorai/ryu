import {
	boxCorners,
	cylinder,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Policyholder correspondence: a mailbox on its post. The drafted update has
 * gone in through the front door and the flag on the side is raised (lit):
 * a letter waiting to be sent. The tray beside it holds the next drafts.
 */

const PLATE = { x: -84, y: -52, w: 168, d: 104, r: 8 };
const POST: [number, number] = [-33, -8];
const BOX = { x: -48, y: -44, w: 30, d: 68, r: 5 };
const BOX_Z = 32;
const BOX_H = 24;
const TRAY = { x: 2, y: -34, w: 70, d: 72, r: 3 };
const TRAY_H = 6;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-16, -30, 72]]);

function envelope(x: number, y: number, z: number, top: boolean) {
	const plan = { x, y, w: 52, d: 32, r: 1 };
	s.solid(slabOf(plan, z, 1.4, s.P, 2), { crease: "none" });
	if (top) {
		const lid = z + 1.4;
		s.line(lineOnTop([x + 1, y + 1], [x + 26, y + 17], lid, s.P), {
			tone: "lo",
		});
		s.line(lineOnTop([x + 26, y + 17], [x + 51, y + 1], lid, s.P), {
			tone: "lo",
		});
		s.solid(
			slabOf({ x: x + 38, y: y + 20, w: 7, d: 7, r: 0.6 }, lid, 0.6, s.P, 2),
			{
				tone: "lo",
				crease: "none",
			}
		);
	}
}

benchPlate(s, PLATE);
// Mailbox: footing, post, and the box itself.
s.halo({ x: POST[0] - 14, y: POST[1] - 14, w: 28, d: 28, r: 4 }, 0);
s.solid(
	slabOf(
		{ x: POST[0] - 12, y: POST[1] - 12, w: 24, d: 24, r: 3 },
		0,
		4,
		s.P,
		4,
		0.6
	),
	{
		tone: "lo",
	}
);
screws(
	s,
	[
		[POST[0] - 8, POST[1] + 8],
		[POST[0] + 8, POST[1] + 8],
	],
	4,
	1.2
);
s.solid(
	slabOf(
		{ x: POST[0] - 4, y: POST[1] - 4, w: 8, d: 8, r: 1 },
		4,
		BOX_Z - 4,
		s.P,
		2
	)
);
s.solid(slabOf(BOX, BOX_Z, BOX_H, s.P, 6, 2.5));
const front = BOX.y + BOX.d;
s.line(
	faceRect(
		s,
		"y",
		front,
		BOX.x + 3,
		BOX.x + BOX.w - 3,
		BOX_Z + 3,
		BOX_Z + BOX_H - 4
	),
	{
		tone: "lo",
	}
);
s.solid(
	slabOf({ x: -36, y: front, w: 6, d: 2, r: 0.4 }, BOX_Z + 12, 2, s.P, 2),
	{
		tone: "lo",
	}
);
// The flag on the side, raised.
const side = BOX.x + BOX.w;
s.solid(cylinder(side + 1, -32, 2.2, BOX_Z + 6, 2, s.P, 16), { tone: "lo" });
s.solid(
	slabOf({ x: side, y: -33.5, w: 2, d: 3, r: 0.3 }, BOX_Z + 6, 30, s.P, 2),
	{
		lit: true,
	}
);
s.solid(
	slabOf({ x: side, y: -33.5, w: 2, d: 13, r: 0.5 }, BOX_Z + 26, 10, s.P, 2),
	{
		lit: true,
	}
);
// Draft tray with a stack of envelopes.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 4, 0.6), { tone: "lo" });
for (let i = 0; i < 4; i++) {
	envelope(
		TRAY.x + 8 + (i % 2) * 2,
		TRAY.y + 10 + i * 6,
		TRAY_H + i * 1.4,
		i === 3
	);
}

export const drawing = cardDrawing(s);
