import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Experiment write-ups: a report printer. The run's cards are stacked in the
 * feed tray on top; the printer sets them out as one finished report on the
 * out-tray in front, with its method, findings and next steps as lines (the
 * lit page).
 */

const PLATE = { x: -84, y: -56, w: 168, d: 112, r: 8 };
const BODY = { x: -62, y: -46, w: 100, d: 50, r: 5 };
const BODY_H = 26;
const FEED = { x: -50, y: -40, w: 50, d: 24, r: 2 };
const TRAY = { x: -52, y: 8, w: 80, d: 40, r: 3 };
const SHEET = insetPlan(TRAY, 6);

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[FEED.x, FEED.y, BODY_H + 12],
]);

benchPlate(s, PLATE);
s.halo(BODY, 0);
s.solid(slabOf(BODY, 0, BODY_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BODY, 4), BODY_H, s.P, 4), { tone: "faint" });
const front = BODY.y + BODY.d;
s.line(faceRect(s, "y", front, TRAY.x + 4, TRAY.x + TRAY.w - 4, 6, 9), {
	tone: "mid",
});
// Feed tray of run cards on top.
s.solid(slabOf(FEED, BODY_H, 3, s.P, 3, 0.4), { tone: "lo" });
for (let i = 0; i < 4; i++) {
	s.solid(slabOf(insetPlan(FEED, 3), BODY_H + 3 + i * 1.8, 1.8, s.P, 2), {
		crease: "none",
	});
}
screws(
	s,
	[
		[BODY.x + BODY.w - 8, BODY.y + 8],
		[BODY.x + 8, BODY.y + BODY.d - 8],
	],
	BODY_H,
	1.4
);
// Control strip: platen knob and status lamps.
s.solid(cylinder(22, -30, 6, BODY_H, 6, s.P, 28, 0.4));
s.line(lineOnTop([22, -30], [27, -30], BODY_H + 6, s.P), { tone: "hi" });
lamp(s, [14, -14], BODY_H, { radius: 1.6 });
lamp(s, [22, -14], BODY_H, { radius: 1.6 });
lamp(s, [30, -14], BODY_H, { radius: 1.6 });
// Out-tray with the finished report.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 4, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(SHEET, 4, 1.4, s.P, 2), { lit: true, crease: "none" });
const top = 5.4;
const widths = [36, 58, 50, 58, 30, 52, 44];
widths.forEach((width, index) => {
	const y = SHEET.y + 5 + index * 3.8;
	s.line(lineOnTop([SHEET.x + 5, y], [SHEET.x + 5 + width, y], top, s.P), {
		tone: index === 0 || index === 4 ? "mid" : "lo",
	});
});

export const drawing = cardDrawing(s);
