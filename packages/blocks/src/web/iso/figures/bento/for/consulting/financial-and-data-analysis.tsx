import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	faceRules,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Financial and data analysis: a two-pan balance. Two sets of figures are
 * stacked side by side on its pans and the centre needle (the lit part)
 * reads which way they tip; the tape printer in front writes out what the
 * comparison means.
 */

const PLATE = { x: -80, y: -30, w: 166, d: 80, r: 8 };
const BASE = { x: -64, y: -16, w: 128, d: 32, r: 4 };
const BASE_H = 12;
// The light side rides high, the heavy side sinks: the comparison tips.
const LIGHT_POST = 20;
const HEAVY_POST = 10;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners({ x: -57, y: -19, w: 114, d: 38, r: 19 }, 0, 44),
]);

function pan(x: number, coins: number, postH: number) {
	const panZ = BASE_H + postH;
	s.solid(cylinder(x, 0, 3.2, BASE_H, postH, s.P, 20));
	s.solid(cylinder(x, 0, 19, panZ, 2.4, s.P, 48, 0.6));
	s.line(ring(x, 0, 16, panZ + 2.4, s.P, 48), { tone: "faint" });
	for (let i = 0; i < coins; i++) {
		s.solid(cylinder(x, 0, 10, panZ + 2.4 + i * 3, 3, s.P, 36, 0.4), {
			tone: i === coins - 1 ? "mid" : "lo",
		});
	}
}

benchPlate(s, PLATE);
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BASE, 4), BASE_H, s.P, 4), { tone: "faint" });
s.line(faceRect(s, "y", BASE.y + BASE.d, -20, 20, 3, 9), { tone: "lo" });
pan(-38, 3, LIGHT_POST);
// Centre scale with its needle.
const scale = { x: -12, y: -10, w: 24, d: 3, r: 0.5 };
s.solid(slabOf(scale, BASE_H, 26, s.P, 2));
faceRules(s, "y", scale.y + scale.d, scale.x + 4, BASE_H + 22, [16, 10, 16], 4);
s.solid(slabOf({ x: 3, y: -5, w: 2.4, d: 2.4, r: 0.4 }, BASE_H, 30, s.P, 2), {
	lit: true,
});
s.solid(cylinder(4.2, -3.8, 3, BASE_H, 3, s.P, 20), { tone: "lo" });
pan(38, 5, HEAVY_POST);
// Tape printer: the written narrative of the result.
const printer = { x: 28, y: 22, w: 46, d: 20, r: 3 };
s.halo(printer, 0);
s.solid(slabOf(printer, 0, 12, s.P, 4, 0.6));
const tape = { x: 36, y: 26, w: 30, d: 20, r: 1 };
s.solid(slabOf(tape, 12, 0.8, s.P, 2), { crease: "none" });
for (let i = 0; i < 3; i++) {
	const y = tape.y + 6 + i * 4.5;
	s.line(lineOnTop([tape.x + 4, y], [tape.x + 26 - i * 6, y], 12.8, s.P), {
		tone: "lo",
	});
}
screws(s, [[printer.x + 5, printer.y + 4]], 12, 1.2);

export const drawing = cardDrawing(s);
