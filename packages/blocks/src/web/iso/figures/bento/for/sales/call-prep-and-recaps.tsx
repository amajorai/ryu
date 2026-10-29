import {
	boxCorners,
	coil,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Call prep and recaps: a desk telephone with its handset on the cradle, and
 * the spiral notepad beside it where the call becomes a recap. The next step
 * ticked at the foot of the page is the lit part.
 */

const PLATE = { x: -100, y: -52, w: 200, d: 104, r: 8 };
const BASE = { x: -90, y: -38, w: 74, d: 72, r: 8 };
const BASE_H = 16;
const PAD = { x: 4, y: -34, w: 76, d: 74, r: 3 };
const PAD_H = 5;
const HANDSET_X = BASE.x + 8;
const HANDSET_Z = BASE_H + 7;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[HANDSET_X, 0, HANDSET_Z + 12],
]);

benchPlate(s, PLATE);
// Telephone: body, cradle posts, handset, then the rotary dial in front.
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 8, 1.4));
s.line(planOutline(insetPlan(BASE, 4), BASE_H, s.P, 6), { tone: "faint" });
const cups = [BASE.y + 8, BASE.y + BASE.d - 8];
for (const y of cups) {
	s.solid(cylinder(HANDSET_X + 8, y, 3, BASE_H, 6, s.P, 20), { tone: "lo" });
}
s.solid(
	cylinder(HANDSET_X + 8, cups[0] ?? 0, 9, HANDSET_Z - 1, 8, s.P, 32, 0.8)
);
s.solid(
	slabOf(
		{
			x: HANDSET_X + 2,
			y: cups[0] ?? 0,
			w: 12,
			d: (cups[1] ?? 0) - (cups[0] ?? 0),
			r: 3,
		},
		HANDSET_Z,
		6,
		s.P,
		4,
		0.6
	)
);
s.solid(
	cylinder(HANDSET_X + 8, cups[1] ?? 0, 9, HANDSET_Z - 1, 8, s.P, 32, 0.8)
);
s.line(ring(HANDSET_X + 8, cups[1] ?? 0, 5, HANDSET_Z + 7, s.P, 24), {
	tone: "lo",
});
const dial: [number, number] = [BASE.x + 46, BASE.y + BASE.d / 2];
s.solid(cylinder(dial[0], dial[1], 15, BASE_H, 2, s.P, 40), { tone: "lo" });
for (let i = 0; i < 10; i++) {
	const angle = -0.4 + (i / 10) * Math.PI * 1.6;
	s.line(
		ring(
			dial[0] + Math.sin(angle) * 9.5,
			dial[1] - Math.cos(angle) * 9.5,
			1.8,
			BASE_H + 2,
			s.P,
			12
		),
		{ tone: "mid" }
	);
}
s.solid(cylinder(dial[0], dial[1], 4, BASE_H + 2, 2, s.P, 20));
lamp(s, [BASE.x + BASE.w - 8, BASE.y + 10], BASE_H, { radius: 1.8 });
// Spiral notepad, wire along its back edge.
s.halo(PAD, 0);
const wire = coil(
	PAD.x + 6,
	PAD.x + PAD.w - 6,
	[PAD.y + 3, PAD_H],
	3,
	12,
	"x",
	s.P
);
s.line(wire.back, { tone: "lo" });
s.solid(slabOf(PAD, 0, PAD_H, s.P, 3, 0.6));
const z = PAD_H;
[56, 44, 60, 36].forEach((length, i) => {
	const y = PAD.y + 14 + i * 7;
	s.line(lineOnTop([PAD.x + 8, y], [PAD.x + 8 + length, y], z, s.P), {
		tone: i === 0 ? "mid" : "lo",
	});
});
for (let i = 0; i < 2; i++) {
	const y = PAD.y + 50 + i * 10;
	const box = { x: PAD.x + 7, y: y - 4, w: 8, d: 8, r: 1 };
	if (i === 1) {
		s.solid(slabOf(box, z, 1.6, s.P, 2), { lit: true, crease: "none" });
	} else {
		s.line(planOutline(box, z, s.P, 2), { tone: "mid" });
	}
	s.line(lineOnTop([PAD.x + 20, y], [PAD.x + 62 - i * 14, y], z, s.P), {
		tone: "lo",
	});
}
s.line(wire.front, { tone: "mid" });

export const drawing = cardDrawing(s);
