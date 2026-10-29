import { boxCorners, lineOnTop, slabOf } from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Firewall inspection: a scanner arch over two tape lanes, one carrying text
 * in and one carrying it back out. Every line on both tapes passes under the
 * scan head (the lit window) on its way through.
 */

const PLATE = { x: -100, y: -48, w: 200, d: 96, r: 8 };
const LANE_H = 6;
const LANES = [-26, 4];
const LANE_D = 22;
const ARCH_X = -8;
const ARCH_W = 18;
const ARCH_H = 44;
const POST_D = 8;
const POST_BACK = { x: ARCH_X, y: -38, w: ARCH_W, d: POST_D, r: 2 };
const POST_FRONT = { x: ARCH_X, y: 30, w: ARCH_W, d: POST_D, r: 2 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[ARCH_X, -38, ARCH_H + 8],
]);

function lane(y: number) {
	const belt = { x: -90, y, w: 180, d: LANE_D, r: 3 };
	s.halo(belt, 0);
	s.solid(slabOf(belt, 0, LANE_H, s.P, 4, 0.6));
	const tape = { x: -84, y: y + 5, w: 168, d: 12, r: 1 };
	s.solid(slabOf(tape, LANE_H, 0.8, s.P, 2), { tone: "lo", crease: "none" });
	const top = LANE_H + 0.8;
	for (let x = -80; x < 78; x += 13) {
		const length = 4 + (((x + 80) * 7) % 6);
		s.line(lineOnTop([x, y + 11], [x + length, y + 11], top, s.P), {
			tone: "mid",
		});
	}
	screws(
		s,
		[
			[-86, y + LANE_D / 2],
			[86, y + LANE_D / 2],
		],
		LANE_H,
		1.2
	);
}

benchPlate(s, PLATE);
s.halo(POST_BACK, 0);
s.solid(slabOf(POST_BACK, 0, ARCH_H, s.P, 3, 0.8));
for (const y of LANES) {
	lane(y);
}
s.halo(POST_FRONT, 0);
s.solid(slabOf(POST_FRONT, 0, ARCH_H, s.P, 3, 0.8));
// The cross beam, with the scan window running its length on top.
const beam = { x: ARCH_X - 2, y: -40, w: ARCH_W + 4, d: 80, r: 3 };
s.solid(slabOf(beam, ARCH_H, 8, s.P, 4, 0.8));
s.solid(
	slabOf(
		{ x: ARCH_X + 4, y: -28, w: ARCH_W - 8, d: 56, r: 2 },
		ARCH_H + 8,
		1.6,
		s.P,
		3
	),
	{ lit: true }
);
lamp(s, [ARCH_X + ARCH_W / 2, -34], ARCH_H + 8, { radius: 1.6 });
lamp(s, [ARCH_X + ARCH_W / 2, 34], ARCH_H + 8, { radius: 1.6 });

export const drawing = cardDrawing(s);
