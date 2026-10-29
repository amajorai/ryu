import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Sensitive data: a page in an inspection tray. Text runs across it as rule
 * lines; one line held a secret and is now covered by a solid redaction bar
 * (the lit part), with the loupe that found it standing beside the tray.
 */

const PLATE = { x: -96, y: -48, w: 192, d: 96, r: 8 };
const TRAY = { x: -70, y: -38, w: 104, d: 76, r: 4 };
const SHEET = insetPlan(TRAY, 7);
const TRAY_H = 6;
const SHEET_Z = TRAY_H - 2;
const LINES = 7;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [64, 0, 40]]);

benchPlate(s, PLATE);
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 6, 0.8));
s.solid(slabOf(SHEET, SHEET_Z, 1.2, s.P, 3), { crease: "none" });
const top = SHEET_Z + 1.2;
for (let i = 0; i < LINES; i++) {
	const y = SHEET.y + 8 + i * 8.6;
	const length = [80, 64, 74, 52, 78, 60, 40][i] ?? 60;
	if (i === 3) {
		s.solid(
			slabOf(
				{ x: SHEET.x + 6, y: y - 2.6, w: 58, d: 5.2, r: 1 },
				top,
				1.6,
				s.P,
				2
			),
			{ lit: true, crease: "none" }
		);
	} else {
		s.line(lineOnTop([SHEET.x + 6, y], [SHEET.x + 6 + length, y], top, s.P), {
			tone: i === 0 ? "mid" : "lo",
		});
	}
}
// The loupe: a ringed lens on a short post.
s.halo({ x: 52, y: -12, w: 24, d: 24, r: 12 }, 0);
s.solid(cylinder(64, 0, 11, 0, 3, s.P, 36, 0.6), { tone: "lo" });
s.solid(cylinder(64, 0, 3, 3, 22, s.P, 20));
s.solid(cylinder(64, 0, 13, 25, 4, s.P, 40, 0.6));
s.line(ring(64, 0, 9.5, 29, s.P, 40), { tone: "lo" });

export const drawing = cardDrawing(s);
