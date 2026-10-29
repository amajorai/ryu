import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Headless and scriptable: a server chassis with no screen at all, fed by a
 * hopper of punched script cards on its lid. Its output leaves through a
 * pipe in its side and drops, one record at a time, into a tray; the newest
 * record (the lit block) has just fallen from the spout.
 */

const PLATE = { x: -86, y: -48, w: 180, d: 96, r: 8 };
const BOX = { x: -74, y: -36, w: 92, d: 52, r: 4 };
const BOX_H = 28;
const TRAY = { x: 44, y: -14, w: 40, d: 50, r: 4 };
const TRAY_H = 5;
const PIPE_Y = -2;
const PIPE_Z = 16;
const SPOUT: [number, number] = [62, PIPE_Y];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-50, -20, BOX_H + 24],
]);

benchPlate(s, PLATE);
// The chassis: drive bays on its face, vents and lamps on its lid.
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BOX, 4), BOX_H, s.P, 4), { tone: "faint" });
const face = BOX.y + BOX.d;
for (let i = 0; i < 4; i++) {
	const x0 = BOX.x + 8 + i * 20;
	s.line(faceRect(s, "y", face, x0, x0 + 16, 6, 12), { tone: "lo" });
	s.line(faceRect(s, "y", face, x0, x0 + 16, 15, 21), { tone: "faint" });
}
for (let i = 0; i < 6; i++) {
	const x = BOX.x + 52 + i * 5;
	s.line(lineOnTop([x, BOX.y + 8], [x, BOX.y + 26], BOX_H, s.P));
}
lamp(s, [BOX.x + 56, BOX.y + 40], BOX_H, { radius: 1.6 });
lamp(s, [BOX.x + 66, BOX.y + 40], BOX_H, { radius: 1.6 });
screws(
	s,
	[
		[BOX.x + 80, BOX.y + 40],
		[BOX.x + 80, BOX.y + 8],
	],
	BOX_H,
	1.4
);
// The hopper of script cards on the lid.
const hopper = { x: BOX.x + 8, y: BOX.y + 8, w: 34, d: 30, r: 2 };
s.solid(slabOf(hopper, BOX_H, 4, s.P, 3, 0.6), { tone: "lo" });
for (let i = 0; i < 5; i++) {
	const card = {
		x: hopper.x + 4 + i * 0.6,
		y: hopper.y + 4 - i * 0.6,
		w: 26,
		d: 22,
		r: 1,
	};
	s.solid(slabOf(card, BOX_H + 4 + i * 3.2, 2.4, s.P, 2), {
		crease: "none",
	});
}
const deck = BOX_H + 4 + 4 * 3.2 + 2.4;
for (let row = 0; row < 3; row++) {
	for (let col = 0; col < 4; col++) {
		const x = hopper.x + 10 + col * 5 + 2.4;
		const y = hopper.y + 6 + row * 6 - 2.4;
		s.line(ring(x, y, 1, deck, s.P, 10), { tone: "lo" });
	}
}
// Output tray on the bench, the records it already holds, and the new one.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 4, 0.6), { tone: "lo" });
s.line(planOutline(insetPlan(TRAY, 3), TRAY_H, s.P, 3), { tone: "faint" });
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf(
			{ x: TRAY.x + 6, y: TRAY.y + 30, w: 28, d: 14, r: 1.5 },
			TRAY_H + i * 2.4,
			2,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
s.solid(
	slabOf(
		{ x: SPOUT[0] - 12, y: SPOUT[1] - 6, w: 24, d: 18, r: 1.5 },
		TRAY_H,
		5,
		s.P,
		2
	),
	{
		lit: true,
	}
);
// The pipe out of the chassis's side, flanged at both ends, with a spout.
s.solid(
	slabOf(
		{ x: BOX.x + BOX.w - 1, y: PIPE_Y - 8, w: 4, d: 16, r: 1 },
		PIPE_Z - 4,
		16,
		s.P,
		2
	),
	{
		tone: "lo",
	}
);
s.solid(
	slabOf(
		{
			x: BOX.x + BOX.w + 3,
			y: PIPE_Y - 4,
			w: SPOUT[0] - BOX.x - BOX.w - 3,
			d: 8,
			r: 3.5,
		},
		PIPE_Z,
		8,
		s.P,
		6
	)
);
s.solid(cylinder(SPOUT[0], SPOUT[1], 6, PIPE_Z - 1, 11, s.P, 28, 0.6));
s.solid(cylinder(SPOUT[0], SPOUT[1], 7.5, PIPE_Z - 3, 2, s.P, 28), {
	tone: "lo",
});
s.line(ring(SPOUT[0], SPOUT[1], 3, PIPE_Z + 10, s.P, 20), { tone: "lo" });

export const drawing = cardDrawing(s);
