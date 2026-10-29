import {
	boxCorners,
	cylinder,
	lineOnTop,
	onTop,
	radialTicks,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Round-screen watch: the watch lying face up on its strap, beside its
 * charging puck. The round screen (the lit part) shows a face; the crown and
 * the pusher on its side are what you press to talk.
 */

const PLATE = { x: -84, y: -56, w: 168, d: 112, r: 8 };
const W: [number, number] = [18, 0];
const STRAP_Z = 3;
const CASE_Z = STRAP_Z;
const CASE_H = 10;
const TOP = CASE_Z + CASE_H;
const R = 32;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, TOP + 6]]);
const [wx, wy] = W;

benchPlate(s, PLATE);
// Charging puck at the back left, with its cable lamp.
const PUCK: [number, number] = [-52, -24];
s.halo({ x: PUCK[0] - 20, y: PUCK[1] - 20, w: 40, d: 40, r: 20 }, 0);
s.solid(cylinder(PUCK[0], PUCK[1], 20, 0, 5, s.P, 48, 0.6), { tone: "lo" });
s.solid(cylinder(PUCK[0], PUCK[1], 14, 5, 1.4, s.P, 40));
s.line(ring(PUCK[0], PUCK[1], 8, 6.4, s.P, 32), { tone: "faint" });
lamp(s, [PUCK[0] + 12, PUCK[1] + 12], 5, { radius: 1.4 });
// The strap, lying flat across the bench under the case.
const strap = { x: wx - 13, y: -52, w: 26, d: 104, r: 8 };
s.halo(strap, 0);
s.solid(slabOf(strap, 0, STRAP_Z, s.P, 6, 0.4), { crease: "none" });
for (let i = 0; i < 5; i++) {
	const y = 36 + i * 3.5;
	s.line(lineOnTop([wx - 2, y], [wx + 2, y], STRAP_Z, s.P), { tone: "mid" });
}
// Buckle at the far end.
s.solid(slabOf({ x: wx - 15, y: -48, w: 30, d: 6, r: 2 }, STRAP_Z, 2, s.P, 3), {
	tone: "lo",
});
// Lugs, then the case.
for (const ly of [-R - 5, R - 1]) {
	s.solid(
		slabOf({ x: wx - 10, y: ly, w: 20, d: 6, r: 1.5 }, STRAP_Z, 6, s.P, 3)
	);
}
s.halo({ x: wx - R, y: wy - R, w: 2 * R, d: 2 * R, r: R }, STRAP_Z);
s.solid(cylinder(wx, wy, R, CASE_Z, CASE_H, s.P, 64, 1));
// Crown and pusher on the side facing you.
s.solid(cylinder(wx + R + 1, wy - 6, 3.4, CASE_Z + 3, 5, s.P, 20));
s.solid(cylinder(wx + R - 1, wy + 9, 2.4, CASE_Z + 3, 4, s.P, 16), {
	tone: "lo",
});
// Bezel ticks, then the lit round screen with its face.
const ticks = radialTicks(wx, wy, R - 1.5, 24, 6, TOP, [1.4, 2.8], s.P);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
s.solid(cylinder(wx, wy, R - 6, TOP, 1, s.P, 64), { lit: true });
const face = TOP + 1;
// Screen "up" is the far corner (-x, -y); screen "right" is (+x, -y).
const H = Math.SQRT1_2;
const onFace = (up: number, right: number): [number, number] => [
	wx - up * H + right * H,
	wy - up * H - right * H,
];
s.dots(
	[onFace(7, -6), onFace(7, 6)].map(([x, y]) => s.at([x, y, face])),
	{ size: 2.2, tone: "hi" }
);
const smile: [number, number][] = [];
for (let i = 0; i <= 10; i++) {
	const a = Math.PI * (0.2 + (0.6 * i) / 10);
	smile.push(onFace(-2 - Math.sin(a) * 8, -Math.cos(a) * 11));
}
s.line(onTop(smile, face, s.P), { tone: "mid" });
screws(
	s,
	[
		[-64, 38],
		[64, -38],
	],
	0,
	1.6
);

export const drawing = cardDrawing(s);
