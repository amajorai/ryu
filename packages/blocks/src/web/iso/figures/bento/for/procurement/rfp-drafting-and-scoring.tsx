import {
	boxCorners,
	cylinder,
	ring,
	segment,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * RFP drafting and scoring: a beam balance. A supplier's response sits in
 * the far pan; your weighted criteria are the stacked weights in the near
 * one, topped by the heaviest criterion (the lit weight). Level beam, fair
 * score.
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const BASE = { x: -26, y: -18, w: 52, d: 36, r: 4 };
const BEAM_Z = 54;
const ARM = 56;
const PAN_Z = 16;
const PAN_R = 18;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, BEAM_Z + 10]]);

function hangers(cx: number) {
	const top: [number, number, number] = [cx, 0, BEAM_Z];
	const rims = [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3].map(
		(a): [number, number, number] => [
			cx + Math.sin(a) * (PAN_R - 3),
			-Math.cos(a) * (PAN_R - 3),
			PAN_Z + 3,
		]
	);
	s.line(rims.map((rim) => segment(top, rim, s.P)).join(""), { tone: "lo" });
}

function pan(cx: number) {
	s.solid(cylinder(cx, 0, PAN_R, PAN_Z, 3, s.P, 40, 0.6));
	s.line(ring(cx, 0, PAN_R - 3, PAN_Z + 3, s.P, 40), { tone: "lo" });
}

benchPlate(s, PLATE);
// Far pan, with the response document stack.
pan(-ARM);
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf(
			{ x: -ARM - 10 + i, y: -8 - i, w: 20, d: 15, r: 1 },
			PAN_Z + 3 + i * 3,
			3,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
hangers(-ARM);
// Base, column and beam.
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, 8, s.P, 6, 0.8));
screws(
	s,
	[
		[BASE.x + 6, BASE.y + 6],
		[BASE.x + BASE.w - 6, BASE.y + BASE.d - 6],
	],
	8,
	1.4
);
knob(s, [BASE.x + BASE.w - 10, BASE.y + 10], 8, 4, 4);
s.solid(cylinder(0, 0, 6, 8, 3, s.P, 28), { tone: "lo" });
s.solid(cylinder(0, 0, 3.5, 11, BEAM_Z - 11, s.P, 24));
s.solid(
	slabOf(
		{ x: -ARM - 3, y: -2.5, w: 2 * ARM + 6, d: 5, r: 1 },
		BEAM_Z,
		4,
		s.P,
		2
	)
);
s.solid(cylinder(0, 0, 5, BEAM_Z + 4, 4, s.P, 24), { tone: "lo" });
s.solid(slabOf({ x: -1, y: -1, w: 2, d: 2, r: 0.4 }, BEAM_Z + 8, 2, s.P, 1), {
	tone: "hi",
});
// Near pan, with the criteria weights.
hangers(ARM);
pan(ARM);
s.solid(cylinder(ARM, 0, 10, PAN_Z + 3, 5, s.P, 32, 0.6));
s.solid(cylinder(ARM, 0, 7.5, PAN_Z + 8, 4, s.P, 32, 0.6));
s.solid(cylinder(ARM, 0, 5, PAN_Z + 12, 4, s.P, 28, 0.4), { lit: true });
s.solid(cylinder(ARM, 0, 2, PAN_Z + 16, 3, s.P, 16), { tone: "lo" });

export const drawing = cardDrawing(s);
