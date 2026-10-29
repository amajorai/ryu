import {
	boxCorners,
	insetPlan,
	lineOnTop,
	type Point3,
	pathOf,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceLine,
	faceRect,
	knob,
	lamp,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Campaign copy in one workflow: one conveyor carries an ad card, an
 * envelope and a landing page in turn into the filing cabinet at the end of
 * the line, your marketing tool. Its lamp (the lit part) shows it saved.
 */

const PLATE = { x: -104, y: -52, w: 208, d: 104, r: 8 };
const BELT = { x: -96, y: -12, w: 132, d: 26, r: 3 };
const BELT_H = 8;
const CAB = { x: 40, y: -34, w: 50, d: 64, r: 3 };
const CAB_H = 40;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CAB.x, CAB.y, CAB_H + 4],
]);

benchPlate(s, PLATE);
// Controller box behind the belt.
const box = { x: -86, y: -42, w: 34, d: 22, r: 3 };
s.halo(box, 0);
s.solid(slabOf(box, 0, 14, s.P, 4, 0.8));
knob(s, [box.x + 10, box.y + 11], 14, 5, 5);
lamp(s, [box.x + 25, box.y + 11], 14, { radius: 1.8 });
// The belt with its roller seams.
s.halo(BELT, 0);
s.solid(slabOf(BELT, 0, BELT_H, s.P, 4, 0.6));
for (let x = BELT.x + 10; x < BELT.x + BELT.w; x += 12) {
	s.line(lineOnTop([x, BELT.y + 2], [x, BELT.y + BELT.d - 2], BELT_H, s.P), {
		tone: "faint",
	});
}
const lay = (x: number, w: number, d: number) => ({
	x,
	y: 1 - d / 2,
	w,
	d,
	r: 1.5,
});
// Ad card.
s.solid(slabOf(lay(-86, 18, 16), BELT_H, 3, s.P, 3));
s.line(lineOnTop([-82, 1], [-74, 1], BELT_H + 3, s.P), { tone: "mid" });
// Envelope with its flap.
const env = lay(-50, 26, 18);
s.solid(slabOf(env, BELT_H, 3, s.P, 2));
const top = BELT_H + 3;
const flap = (x: number, y: number): Point3 => [x, y, top];
s.line(
	pathOf(
		[
			flap(env.x, env.y),
			flap(env.x + 13, env.y + 9),
			flap(env.x + 26, env.y),
		].map(s.at)
	),
	{
		tone: "lo",
	}
);
// Landing page: a thicker sheaf.
const page = lay(-10, 20, 22);
s.solid(slabOf(page, BELT_H, 7, s.P, 3));
s.line(planOutline(insetPlan(page, 3), BELT_H + 7, s.P, 2), { tone: "faint" });
// Filing cabinet at the end of the line.
s.halo(CAB, 0);
s.solid(slabOf(CAB, 0, CAB_H, s.P, 4, 1));
const front = CAB.y + CAB.d;
for (const [z0, z1] of [
	[4, 18],
	[22, 36],
] as const) {
	s.line(faceRect(s, "y", front, CAB.x + 6, CAB.x + CAB.w - 6, z0, z1), {
		tone: "lo",
	});
	s.line(faceLine(s, "y", front, CAB.x + 18, CAB.x + 32, z1 - 4), {
		tone: "mid",
	});
}
s.line(faceRect(s, "x", CAB.x + CAB.w, CAB.y + 22, CAB.y + 42, 30, 34), {
	tone: "lo",
});
lamp(s, [CAB.x + CAB.w - 10, CAB.y + CAB.d - 10], CAB_H, {
	lit: true,
	radius: 2.4,
});

export const drawing = cardDrawing(s);
