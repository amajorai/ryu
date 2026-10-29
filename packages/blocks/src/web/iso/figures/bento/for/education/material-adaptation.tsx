import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	lamp,
	ruler,
	screws,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Material adaptation: a rewriting press on a feed bed. A dense passage goes
 * in at the back, the level slider on top (the lit block) sets the reading
 * level, and the same page comes out the front in fewer, plainer lines.
 */

const PLATE = { x: -104, y: -46, w: 208, d: 92, r: 8 };
const BED = { x: -94, y: -16, w: 188, d: 32, r: 3 };
const BED_H = 5;
const BODY = { x: -24, y: -34, w: 48, d: 68, r: 5 };
const BODY_H = 34;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, BODY_H + 6]]);

function page(x: number, rows: number, lengths: number[]) {
	const sheet = { x, y: -12, w: 48, d: 24, r: 1 };
	s.solid(slabOf(sheet, BED_H, 0.8, s.P, 2), { crease: "none" });
	const top = BED_H + 0.8;
	for (let i = 0; i < rows; i++) {
		const y = sheet.y + 4 + (i * 16) / Math.max(1, rows - 1);
		const length = lengths[i % lengths.length] ?? 30;
		s.line(lineOnTop([x + 4, y], [x + 4 + length, y], top, s.P), {
			tone: "lo",
		});
	}
}

benchPlate(s, PLATE);
s.halo(BED, 0);
s.solid(slabOf(BED, 0, BED_H, s.P, 4, 0.6));
screws(
	s,
	[
		[BED.x + 6, 0],
		[BED.x + BED.w - 6, 0],
	],
	BED_H,
	1.4
);
page(-84, 9, [40, 34, 38, 30, 40]);
// The press straddling the bed.
s.halo(BODY, 0);
s.solid(slabOf(BODY, 0, BODY_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BODY, 5), BODY_H, s.P, 4), { tone: "faint" });
ruler(s, { x: -10, y: -26, w: 10, d: 52, r: 1 }, BODY_H, "y");
s.solid(slabOf({ x: -12, y: 2, w: 14, d: 9, r: 1.5 }, BODY_H, 6, s.P, 2, 0.4), {
	lit: true,
});
lamp(s, [12, -24], BODY_H, { radius: 1.8 });
screws(
	s,
	[
		[12, 24],
		[-18, -28],
	],
	BODY_H,
	1.3
);
s.line(faceRect(s, "x", BODY.x + BODY.w, -14, 14, BED_H, BED_H + 6), {
	tone: "lo",
});
page(36, 4, [22, 28, 18]);

export const drawing = cardDrawing(s);
