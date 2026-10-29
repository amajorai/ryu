import {
	boxCorners,
	cylinder,
	insetPlan,
	onTop,
	type Plane,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, byDepth, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Bring your history: a reel-to-reel reader. The full reel on the left holds
 * the old threads; the tape runs past the read head (the lit part) onto the
 * take-up reel, so the history plays straight into Ryu.
 */

const PLATE = { x: -100, y: -56, w: 200, d: 112, r: 8 };
const DECK = { x: -88, y: -46, w: 176, d: 90, r: 6 };
const H = 12;
const REEL_R = 30;
const LEFT: [number, number] = [-46, -14];
const RIGHT: [number, number] = [44, -14];
const HEAD: [number, number] = [-1, 30];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, H + 14]]);

function reel([x, y]: [number, number], pack: number) {
	s.solid(cylinder(x, y, REEL_R, H, 2, s.P, 56, 0.4), { tone: "lo" });
	s.solid(cylinder(x, y, pack, H + 2, 7, s.P, 56));
	s.solid(cylinder(x, y, REEL_R, H + 9, 1.2, s.P, 56, 0.4), { tone: "lo" });
	s.line(ring(x, y, pack, H + 10.2, s.P, 56), { tone: "faint" });
	s.solid(cylinder(x, y, 7, H + 10.2, 1, s.P, 28));
	s.solid(cylinder(x, y, 2.6, H + 11, 3, s.P, 20), { tone: "lo" });
}

benchPlate(s, PLATE);
s.halo(DECK, 0);
s.solid(slabOf(DECK, 0, H, s.P, 8, 1.2));
s.line(planOutline(insetPlan(DECK, 4), H, s.P, 6), { tone: "faint" });
screws(
	s,
	[
		[DECK.x + 8, DECK.y + 8],
		[DECK.x + DECK.w - 8, DECK.y + 8],
	],
	H,
	1.6
);
reel(LEFT, 26);
reel(RIGHT, 13);
// Tape path: off the full reel, round two guide rollers and over the head.
const rollers: [Plane, Plane] = [
	[-30, 26],
	[28, 26],
];
for (const [x, y] of byDepth(rollers, s, H)) {
	s.solid(cylinder(x, y, 3.4, H, 9, s.P, 24));
}
const tapeZ = H + 5;
// Where the tape leaves a reel: its flange rim, facing the roller it feeds.
function rim([x, y]: [number, number], [tx, ty]: [number, number]) {
	const length = Math.hypot(tx - x, ty - y);
	return [
		x + ((tx - x) / length) * REEL_R,
		y + ((ty - y) / length) * REEL_R,
	] as [number, number];
}
s.line(
	onTop(
		[
			rim(LEFT, rollers[0]),
			rollers[0],
			HEAD,
			rollers[1],
			rim(RIGHT, rollers[1]),
		],
		tapeZ,
		s.P
	),
	{ tone: "hi" }
);
const head = { x: HEAD[0] - 7, y: HEAD[1], w: 14, d: 8, r: 1.5 };
s.solid(slabOf(head, H, 10, s.P, 3, 0.4), { lit: true });
// Transport keys and a level lamp along the front edge.
for (const x of [-74, -62, -50]) {
	s.solid(slabOf({ x, y: 30, w: 9, d: 8, r: 1 }, H, 3, s.P, 2), {
		tone: "lo",
	});
}
lamp(s, [70, 34], H, { radius: 2.2 });

export const drawing = cardDrawing(s);
