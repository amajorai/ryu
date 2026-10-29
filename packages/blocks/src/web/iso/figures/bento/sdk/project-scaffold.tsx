import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, byDepth, ruler, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Project scaffold: a cutting jig beside its spec sheet. The sheet on the left
 * is the manifest; the jig on the right has a pocket for every part it names,
 * and the parts already sit in their pockets. The last one set in place (the
 * lit block) is the one the jig was made to hold.
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const CLIP = { x: -88, y: -40, w: 62, d: 80, r: 3 };
const SHEET = insetPlan(CLIP, 4);
const JIG = { x: -12, y: -40, w: 98, d: 80, r: 5 };
const JIG_H = 10;
// Pockets: plan inside the jig, block height, and whether it is the lit one.
const POCKETS: [number, number, number, number, number, boolean][] = [
	[-4, -32, 38, 30, 14, false],
	[42, -32, 36, 30, 22, false],
	[-4, 6, 24, 26, 18, false],
	[28, 6, 50, 26, 12, true],
];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[60, -17, JIG_H + 24],
]);

benchPlate(s, PLATE);
// Clipboard and its spec sheet: rows of rules, one per pocket.
s.halo(CLIP, 0);
s.solid(slabOf(CLIP, 0, 3, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(SHEET, 3, 1, s.P, 3), { crease: "none" });
s.solid(
	slabOf(
		{ x: CLIP.x + 18, y: CLIP.y - 2, w: 26, d: 8, r: 2 },
		4,
		4,
		s.P,
		3,
		0.4
	),
	{
		tone: "lo",
	}
);
for (let i = 0; i < 8; i++) {
	const y = SHEET.y + 14 + i * 7.6;
	const length = [44, 30, 40, 26, 46, 34, 22, 38][i] ?? 30;
	s.line(lineOnTop([SHEET.x + 5, y], [SHEET.x + 5 + length, y], 4, s.P), {
		tone: i === 0 ? "mid" : "lo",
	});
}
// The jig block, its pockets outlined on top, parts seated in each.
s.halo(JIG, 0);
s.solid(slabOf(JIG, 0, JIG_H, s.P, 6, 0.8));
screws(
	s,
	[
		[JIG.x + 5, JIG.y + JIG.d - 5],
		[JIG.x + JIG.w - 5, JIG.y + 5],
	],
	JIG_H,
	1.3
);
const ordered = byDepth(
	POCKETS.map(
		([x, y, w, d, h, lit]) =>
			[x + w / 2, y + d / 2, x, y, w, d, h, lit] as const
	),
	s
);
for (const [, , x, y, w, d, h, lit] of ordered) {
	const pocket = { x, y, w, d, r: 2 };
	s.line(planOutline(pocket, JIG_H, s.P, 2), { tone: "mid" });
	const part = insetPlan(pocket, 2.5);
	s.solid(slabOf(part, JIG_H - 3, h, s.P, 3, 0.6), { lit });
}
ruler(s, { x: JIG.x + 4, y: JIG.y + JIG.d + 3, w: JIG.w - 8, d: 6, r: 1 }, 0);

export const drawing = cardDrawing(s);
