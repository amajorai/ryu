import {
	boxCorners,
	cylinder,
	type Point3,
	pathOf,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, knob, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Screenless necklace: the pendant hanging from a jewellery stand. It has no
 * screen, only a microphone grille on its face and a listening light (the
 * lit nub) that comes on when it hears speech.
 */

const PLATE = { x: -80, y: -50, w: 160, d: 100, r: 8 };
const POST: [number, number] = [-14, -4];
const ARM_Z = 76;
const ARM_HALF = 34;
const PEND = { x: -17.5, y: 22, w: 7, d: 20, r: 2.5 };
const PEND_Z = 30;
const PEND_H = 34;
const FACE = PEND.x + PEND.w;
const MID = PEND.y + PEND.d / 2;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[POST[0], POST[1], ARM_Z + 6],
]);

/** One strand of the chain looped over the arm end, down to the pendant's bail. */
function chain(fromY: number) {
	const top: Point3 = [POST[0], fromY, ARM_Z];
	const bail: Point3 = [PEND.x + PEND.w / 2, MID, PEND_Z + PEND_H + 5];
	const points: Point3[] = [];
	for (let i = 0; i <= 14; i++) {
		const t = i / 14;
		const sag = Math.sin(Math.PI * t) * 1.5;
		points.push([
			top[0] + (bail[0] - top[0]) * t,
			top[1] + (bail[1] - top[1]) * t,
			top[2] + (bail[2] - top[2]) * t - sag,
		]);
	}
	s.line(pathOf(points.map(s.at)), { tone: "mid" });
	s.dots(points.slice(1, -1).map(s.at), { size: 0.8, tone: "hi" });
}

benchPlate(s, PLATE);
// The stand: a weighted round foot, a post and a cross arm.
s.halo({ x: POST[0] - 30, y: POST[1] - 30, w: 60, d: 60, r: 30 }, 0);
s.solid(cylinder(POST[0], POST[1], 30, 0, 5, s.P, 56, 0.8));
s.line(ring(POST[0], POST[1], 24, 5, s.P, 48), { tone: "faint" });
s.solid(cylinder(POST[0], POST[1], 6, 5, 2, s.P, 24), { tone: "lo" });
s.solid(cylinder(POST[0], POST[1], 3, 7, ARM_Z - 7, s.P, 20));
s.solid(
	slabOf(
		{
			x: POST[0] - 2.5,
			y: POST[1] - ARM_HALF - 3,
			w: 5,
			d: 2 * ARM_HALF + 6,
			r: 2,
		},
		ARM_Z,
		4,
		s.P,
		3
	)
);
for (const y of [POST[1] - ARM_HALF, POST[1] + ARM_HALF]) {
	s.solid(cylinder(POST[0], y, 3.4, ARM_Z + 4, 2, s.P, 16), { tone: "lo" });
}
s.solid(cylinder(POST[0], POST[1], 4, ARM_Z + 4, 3, s.P, 20));
// The pendant: body, grille and listening light, then its bail and chain.
s.solid(slabOf(PEND, PEND_Z, PEND_H, s.P, 4, 0.8));
s.line(
	faceRect(
		s,
		"x",
		FACE,
		PEND.y + 3,
		PEND.y + PEND.d - 3,
		PEND_Z + 3,
		PEND_Z + 25
	),
	{
		tone: "lo",
	}
);
const grille: [number, number, number][] = [];
for (let row = 0; row < 4; row++) {
	for (let col = 0; col < 4; col++) {
		grille.push([FACE, PEND.y + 4 + col * 4, PEND_Z + 7 + row * 4.5]);
	}
}
s.dots(grille.map(s.at), { size: 1, tone: "hi" });
s.solid(
	slabOf({ x: FACE, y: MID - 3, w: 1.8, d: 6, r: 1 }, PEND_Z + 27.5, 4, s.P, 3),
	{ lit: true }
);
s.solid(cylinder(PEND.x + PEND.w / 2, MID, 3, PEND_Z + PEND_H, 4, s.P, 16), {
	tone: "lo",
});
chain(POST[1] + ARM_HALF - 4);
chain(POST[1] + ARM_HALF + 2);
// A charging dish in front, with its knob.
const dish = { x: 34, y: 14, w: 34, d: 24, r: 4 };
s.halo(dish, 0);
s.solid(slabOf(dish, 0, 4, s.P, 4, 0.6), { tone: "lo" });
s.solid(cylinder(46, 26, 7, 4, 1.2, s.P, 28));
knob(s, [61, 26], 4, 2.6, 3);
screws(
	s,
	[
		[-60, 32],
		[60, -32],
	],
	0,
	1.6
);

export const drawing = cardDrawing(s);
