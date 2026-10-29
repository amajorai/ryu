import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	segment,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Patient messages: a desk post box. Drafted reminders and aftercare notes
 * lie sealed in the outgoing tray; the one a staff member is sending stands
 * half into the slot on top of the box (the lit envelope). A rubber stamp
 * waits beside the tray.
 */

const PLATE = { x: -92, y: -46, w: 184, d: 92, r: 8 };
const BOX = { x: 22, y: -40, w: 54, d: 46, r: 4 };
const BOX_H = 46;
const TRAY = { x: -80, y: -24, w: 60, d: 48, r: 3 };
const ENVELOPE = { w: 44, d: 30 };
const SLOT = { x: BOX.x + 10, y: BOX.y + 20, w: 34, d: 4, r: 1 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[BOX.x + 27, BOX.y + 22, BOX_H + 24],
]);

function envelopeFlap(x: number, y: number, z: number) {
	const mid: [number, number] = [x + ENVELOPE.w / 2, y + ENVELOPE.d / 2];
	s.line(lineOnTop([x + 1, y + 1], mid, z, s.P), { tone: "lo" });
	s.line(lineOnTop(mid, [x + ENVELOPE.w - 1, y + 1], z, s.P), { tone: "lo" });
}

benchPlate(s, PLATE);
// The outgoing tray of sealed envelopes.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 5, s.P, 4, 0.6), { tone: "lo" });
const stack: [number, number][] = [
	[-2, 1],
	[2, -1],
	[0, 2],
];
let z = 5;
for (const [dx, dy] of stack) {
	const x = TRAY.x + 8 + dx;
	const y = TRAY.y + 9 + dy;
	s.solid(
		slabOf({ x, y, w: ENVELOPE.w, d: ENVELOPE.d, r: 1 }, z, 1.6, s.P, 2),
		{
			crease: "none",
		}
	);
	z += 1.6;
}
envelopeFlap(TRAY.x + 8, TRAY.y + 11, z);
// The post box on its plinth, door and slot outlined, the letter going in.
s.halo(BOX, 0);
s.solid(slabOf(insetPlan(BOX, -2), 0, 3, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(BOX, 3, BOX_H - 3, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BOX, 4), BOX_H, s.P, 4), { tone: "faint" });
const front = BOX.y + BOX.d;
s.line(faceRect(s, "y", front, BOX.x + 8, BOX.x + BOX.w - 8, 8, 34), {
	tone: "lo",
});
s.line(
	faceRect(s, "y", front, BOX.x + BOX.w - 16, BOX.x + BOX.w - 12, 19, 23),
	{
		tone: "mid",
	}
);
s.line(planOutline(SLOT, BOX_H, s.P, 2), { tone: "mid" });
screws(
	s,
	[
		[BOX.x + 8, BOX.y + 8],
		[BOX.x + BOX.w - 8, BOX.y + 8],
	],
	BOX_H,
	1.4
);
const letter = { x: SLOT.x + 3, y: SLOT.y + 1, w: SLOT.w - 6, d: 1.6, r: 0.3 };
s.solid(slabOf(letter, BOX_H, 20, s.P, 2), { lit: true, crease: "none" });
const face = letter.y + letter.d;
const top = BOX_H + 20;
const mid = letter.x + letter.w / 2;
s.line(segment([letter.x + 1, face, top - 1], [mid, face, top - 9], s.P), {
	tone: "lo",
});
s.line(
	segment([mid, face, top - 9], [letter.x + letter.w - 1, face, top - 1], s.P),
	{
		tone: "lo",
	}
);
// The rubber stamp: a pad-backed block with a turned handle.
const STAMP: [number, number] = [44, 30];
s.halo({ x: STAMP[0] - 12, y: STAMP[1] - 9, w: 24, d: 18, r: 3 }, 0);
s.solid(
	slabOf(
		{ x: STAMP[0] - 12, y: STAMP[1] - 9, w: 24, d: 18, r: 2 },
		0,
		3,
		s.P,
		3
	),
	{ tone: "lo" }
);
s.solid(
	slabOf(
		{ x: STAMP[0] - 10, y: STAMP[1] - 7, w: 20, d: 14, r: 2 },
		3,
		6,
		s.P,
		3,
		0.4
	)
);
s.solid(cylinder(STAMP[0], STAMP[1], 2.6, 9, 6, s.P, 20));
s.solid(cylinder(STAMP[0], STAMP[1], 6, 15, 7, s.P, 28, 1.2));

export const drawing = cardDrawing(s);
