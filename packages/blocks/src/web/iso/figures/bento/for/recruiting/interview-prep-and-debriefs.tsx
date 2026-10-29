import { boxCorners, cylinder, ring, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Interview prep and debriefs: the panel's round table. A briefing card sits
 * at each interviewer's place; the folder in the middle (the lit part) is the
 * candidate brief going out and the debrief coming back together.
 */

const PLATE = { x: -72, y: -72, w: 144, d: 144, r: 10 };
const TABLE_R = 38;
const TABLE_Z = 20;
const SEAT_R = 52;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, 0, TABLE_Z + 10],
]);

const seats: [number, number, number][] = [0, 1, 2, 3].map((i) => {
	const angle = Math.PI / 4 + (i * Math.PI) / 2;
	return [Math.cos(angle) * SEAT_R, Math.sin(angle) * SEAT_R, angle];
});

function stool([x, y]: [number, number, number]) {
	s.halo({ x: x - 9, y: y - 9, w: 18, d: 18, r: 9 }, 0);
	s.solid(cylinder(x, y, 8, 0, 2, s.P, 28, 0.4), { tone: "lo" });
	s.solid(cylinder(x, y, 2.6, 2, 11, s.P, 16));
	s.solid(cylinder(x, y, 11, 13, 4, s.P, 32, 0.8));
}

function table() {
	s.halo({ x: -18, y: -18, w: 36, d: 36, r: 18 }, 0);
	s.solid(cylinder(0, 0, 16, 0, 2, s.P, 36, 0.4), { tone: "lo" });
	s.solid(cylinder(0, 0, 5, 2, TABLE_Z - 2, s.P, 24));
	s.solid(cylinder(0, 0, TABLE_R, TABLE_Z, 3, s.P, 64, 0.8));
	s.line(ring(0, 0, TABLE_R - 4, TABLE_Z + 3, s.P, 64), { tone: "faint" });
	const top = TABLE_Z + 3;
	// A briefing card at each place, toward its stool.
	for (const [sx, sy] of byDepth(seats, s, top)) {
		const cx = (sx / SEAT_R) * 24;
		const cy = (sy / SEAT_R) * 24;
		s.solid(
			slabOf({ x: cx - 5, y: cy - 4, w: 10, d: 8, r: 1 }, top, 1, s.P, 2),
			{
				crease: "none",
			}
		);
	}
	s.solid(slabOf({ x: -9, y: -7, w: 18, d: 14, r: 1.5 }, top, 3, s.P, 2), {
		lit: true,
	});
}

benchPlate(s, PLATE);
const ordered = byDepth(seats, s);
const far = ordered.filter(([x, y]) => x + y < 0.5 * SEAT_R);
const near = ordered.filter(([x, y]) => x + y >= 0.5 * SEAT_R);
for (const seat of far) {
	stool(seat);
}
table();
for (const seat of near) {
	stool(seat);
}

export const drawing = cardDrawing(s);
