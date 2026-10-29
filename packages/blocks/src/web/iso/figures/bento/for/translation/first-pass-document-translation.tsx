import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRules,
	knob,
	lamp,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * First-pass document translation: a feeder press. The source stack waits in
 * the in-tray at the back; the press turns each page past its glossary drum
 * and lays the drafted page (the lit sheet) in the out-tray, ready for review.
 */

const PLATE = { x: -104, y: -50, w: 208, d: 100, r: 8 };
const IN_TRAY = { x: -94, y: -36, w: 52, d: 60, r: 3 };
const BODY = { x: -34, y: -38, w: 62, d: 66, r: 5 };
const BODY_H = 30;
const OUT_TRAY = { x: 38, y: -22, w: 56, d: 62, r: 3 };
const TRAY_H = 4;
const DRUM: [number, number] = [-16, -18];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[DRUM[0], DRUM[1], BODY_H + 14],
]);

function sheet(tray: typeof IN_TRAY, z: number, lit = false) {
	s.solid(slabOf(insetPlan(tray, 5), z, 1.4, s.P, 2), {
		lit,
		crease: "none",
	});
}

function rules(tray: typeof IN_TRAY, z: number, widths: number[]) {
	const page = insetPlan(tray, 5);
	widths.forEach((width, index) => {
		const y = page.y + 8 + index * 7;
		s.line(lineOnTop([page.x + 5, y], [page.x + 5 + width, y], z, s.P), {
			tone: index === 0 ? "mid" : "lo",
		});
	});
}

benchPlate(s, PLATE);
// In-tray with the source stack.
s.halo(IN_TRAY, 0);
s.solid(slabOf(IN_TRAY, 0, TRAY_H, s.P, 3, 0.6), { tone: "lo" });
for (let i = 0; i < 4; i++) {
	sheet(IN_TRAY, TRAY_H + i * 1.4);
}
rules(IN_TRAY, TRAY_H + 5.6, [32, 26, 36, 20, 30, 34]);
// The press body: feed slot behind, glossary drum on top, lamp and knob.
s.halo(BODY, 0);
s.solid(slabOf(BODY, 0, BODY_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BODY, 5), BODY_H, s.P, 4), { tone: "faint" });
const slot = { x: BODY.x + 8, y: BODY.y + 4, w: 46, d: 4, r: 1 };
s.line(planOutline(slot, BODY_H, s.P, 2), { tone: "mid" });
s.solid(cylinder(DRUM[0], DRUM[1], 12, BODY_H, 2, s.P, 40), { tone: "lo" });
s.solid(cylinder(DRUM[0], DRUM[1], 10, BODY_H + 2, 10, s.P, 40));
s.line(knurl(DRUM[0], DRUM[1], 10, BODY_H + 2, BODY_H + 12, 36, s.P), {
	tone: "lo",
});
s.line(ring(DRUM[0], DRUM[1], 4, BODY_H + 12, s.P, 24), { tone: "mid" });
lamp(s, [BODY.x + BODY.w - 10, BODY.y + 12], BODY_H, { radius: 1.8 });
knob(s, [BODY.x + BODY.w - 12, BODY.y + 34], BODY_H, 5, 5);
screws(
	s,
	[
		[BODY.x + 7, BODY.y + BODY.d - 7],
		[BODY.x + BODY.w - 7, BODY.y + BODY.d - 7],
	],
	BODY_H,
	1.4
);
faceRules(s, "y", BODY.y + BODY.d, BODY.x + 8, BODY_H - 8, [30, 22, 26], 5);
// Out-tray with the drafted page.
s.halo(OUT_TRAY, 0);
s.solid(slabOf(OUT_TRAY, 0, TRAY_H, s.P, 3, 0.6), { tone: "lo" });
sheet(OUT_TRAY, TRAY_H, true);
rules(OUT_TRAY, TRAY_H + 1.4, [36, 28, 40, 22, 34, 38]);

export const drawing = cardDrawing(s);
