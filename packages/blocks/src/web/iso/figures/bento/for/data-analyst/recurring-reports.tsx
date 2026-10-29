import {
	boxCorners,
	cylinder,
	lineOnTop,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Recurring reports: a weekday carousel. Seven cups ring a turntable, one per
 * day; the arm on the hub has come round to Monday's cup (the lit one), and
 * the reports it ran wait stacked in the out-tray beside it.
 */

const PLATE = { x: -96, y: -56, w: 192, d: 112, r: 8 };
const C: [number, number] = [-28, 0];
const R = 46;
const BASE_H = 6;
const DAYS = 7;
const MONDAY = 2;
const CUP_R = 6.5;
const TRAY = { x: 36, y: -26, w: 48, d: 54, r: 4 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [C[0], C[1], 40]]);

// Monday sits straight along +x from the hub, so the pointer arm is square.
const cupAt = (day: number): [number, number] => {
	const angle = ((day - MONDAY) / DAYS) * Math.PI * 2;
	return [C[0] + Math.cos(angle) * 33, C[1] + Math.sin(angle) * 33];
};
const hubTop = BASE_H + 24;
const ARM_Z = hubTop + 3;

function cup(x: number, y: number, lit: boolean) {
	s.solid(cylinder(x, y, CUP_R, BASE_H, 9, s.P, 28, 0.4), { lit });
	s.line(ring(x, y, CUP_R - 1.6, BASE_H + 9, s.P, 24), { tone: "lo" });
}

benchPlate(s, PLATE);
s.halo({ x: C[0] - R, y: C[1] - R, w: 2 * R, d: 2 * R, r: R }, 0);
s.solid(cylinder(C[0], C[1], R, 0, BASE_H, s.P, 64, 0.8));
s.line(ring(C[0], C[1], R - 5, BASE_H, s.P, 64), { tone: "faint" });
const cups = Array.from(
	{ length: DAYS },
	(_, day) => [...cupAt(day), day] as [number, number, number]
);
const ordered = byDepth(cups, s);
// Far half of the ring first.
for (const [x, y, day] of ordered) {
	if (y < -1) {
		cup(x, y, day === MONDAY);
	}
}
// Hub, then Monday's cup with the arm's finger dropped into it.
const [mx, my] = cupAt(MONDAY);
s.solid(cylinder(C[0], C[1], 8, BASE_H, 3, s.P, 32), { tone: "lo" });
s.solid(cylinder(C[0], C[1], 4.5, BASE_H + 3, 21, s.P, 24));
s.solid(cylinder(C[0], C[1], 6, hubTop, 3, s.P, 28, 0.4));
cup(mx, my, true);
s.solid(cylinder(mx, my, 1.6, BASE_H + 5, ARM_Z - BASE_H - 5, s.P, 16), {
	tone: "lo",
});
s.solid(
	slabOf(
		{ x: C[0] - 4, y: C[1] - 2.5, w: mx - C[0] + 7, d: 5, r: 2 },
		ARM_Z,
		4,
		s.P,
		2,
		0.4
	)
);
screws(s, [[C[0], C[1]]], ARM_Z + 4, 1.4);
// Near half of the ring last.
for (const [x, y, day] of ordered) {
	if (y > 1) {
		cup(x, y, day === MONDAY);
	}
}
// The out-tray with the week's reports stacked in it.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 4, s.P, 4, 0.6), { tone: "lo" });
for (let i = 0; i < 4; i++) {
	const sheet = { x: TRAY.x + 7 - i, y: TRAY.y + 7 + i, w: 34, d: 40, r: 1.5 };
	s.solid(slabOf(sheet, 4 + i * 2, 2, s.P, 2), { crease: "none" });
}
const top = 4 + 4 * 2;
[22, 16, 20].forEach((length, i) => {
	const y = TRAY.y + 18 + i * 7;
	s.line(lineOnTop([TRAY.x + 10, y], [TRAY.x + 10 + length, y], top, s.P), {
		tone: i === 0 ? "mid" : "lo",
	});
});
screws(s, [[TRAY.x + TRAY.w - 5, TRAY.y + 5]], 4, 1.2);

export const drawing = cardDrawing(s);
