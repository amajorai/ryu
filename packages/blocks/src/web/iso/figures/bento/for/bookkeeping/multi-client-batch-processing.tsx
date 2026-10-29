import {
	boxCorners,
	cylinder,
	radialTicks,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, knob, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Multi-client batch processing: an indexing turntable. Each client's book
 * is one box around the platter; the table steps round on a schedule and the
 * press on the gantry runs the same routine on whichever box is under it.
 * Each box carries a status lamp, and the one that needs attention is lit.
 */

const PLATE = { x: -74, y: -54, w: 152, d: 108, r: 8 };
const C: [number, number] = [-16, 2];
const TABLE_R = 46;
const PLATTER_Z = 8;
const BOX = 18;
const BOX_H = 13;
const ORBIT = 30;
const PRESS_ANGLE = -0.35;
const ARM_Z = 46;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[60, -10, ARM_Z + 6],
]);

type Slot = [number, number, number];
const slots: Slot[] = Array.from({ length: 6 }, (_, i) => {
	const a = PRESS_ANGLE + (i * Math.PI) / 3;
	return [C[0] + Math.cos(a) * ORBIT, C[1] + Math.sin(a) * ORBIT, i];
});
const [pressX, pressY] = slots[0] ?? [0, 0];

function clientBox([x, y, i]: Slot) {
	const plan = { x: x - BOX / 2, y: y - BOX / 2, w: BOX, d: BOX, r: 2 };
	s.halo(plan, PLATTER_Z, 3);
	s.solid(slabOf(plan, PLATTER_Z, BOX_H, s.P, 3, 0.6));
	lamp(s, [x + 3, y + 3], PLATTER_Z + BOX_H, { lit: i === 2, radius: 2.6 });
}

benchPlate(s, PLATE);
s.halo(
	{
		x: C[0] - TABLE_R,
		y: C[1] - TABLE_R,
		w: TABLE_R * 2,
		d: TABLE_R * 2,
		r: TABLE_R,
	},
	0
);
s.solid(cylinder(C[0], C[1], TABLE_R, 0, 4, s.P, 64, 0.6), { tone: "lo" });
s.solid(cylinder(C[0], C[1], TABLE_R - 2, 4, PLATTER_Z - 4, s.P, 64, 0.6));
const ticks = radialTicks(
	C[0],
	C[1],
	TABLE_R - 4,
	36,
	6,
	PLATTER_Z,
	[2, 4],
	s.P
);
s.line(ticks.minor, { tone: "faint" });
s.line(ticks.major, { tone: "lo" });
s.solid(cylinder(C[0], C[1], 8, PLATTER_Z, 4, s.P, 28), { tone: "lo" });
s.line(ring(C[0], C[1], 4, PLATTER_Z + 4, s.P, 20), { tone: "mid" });
const ordered = byDepth(slots, s, PLATTER_Z);
const pressIndex = ordered.findIndex((slot) => slot[2] === 0);
for (const slot of ordered.slice(0, pressIndex + 1)) {
	clientBox(slot);
}
s.solid(
	slabOf(
		{ x: pressX - 6, y: pressY - 4, w: 46 - pressX + 6, d: 8, r: 1 },
		ARM_Z,
		5,
		s.P,
		2
	)
);
s.solid(cylinder(pressX, pressY, 4, ARM_Z - 12, 12, s.P, 24));
s.solid(cylinder(pressX, pressY, 9, ARM_Z - 20, 8, s.P, 28, 0.6), {
	tone: "lo",
});
for (const slot of ordered.slice(pressIndex + 1)) {
	clientBox(slot);
}
// Gantry post at the right, nearest the viewer; its arm reaches over the
// press station, so it is drawn after the boxes it stands in front of.
const post = { x: 46, y: pressY - 7, w: 14, d: 14, r: 2 };
s.halo(post, 0);
s.solid(slabOf(post, 0, ARM_Z + 6, s.P, 4, 0.8));
knob(s, [50, 36], 0, 6, 6);
knob(s, [64, 36], 0, 4, 5);

export const drawing = cardDrawing(s);
