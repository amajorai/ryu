import {
	boxCorners,
	corners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Design to front-end: a press. The mockup lies on the bed under a die cut
 * from your tokens; what comes out on the run-out tray is a pressed
 * component (the lit part), waiting there for a developer to pick up.
 */

const PLATE = { x: -96, y: -52, w: 192, d: 104, r: 8 };
const BED = { x: -78, y: -36, w: 84, d: 72, r: 4 };
const BED_H = 8;
const HEAD = { x: -78, y: -36, w: 84, d: 72, r: 4 };
const HEAD_Z = 44;
const HEAD_H = 10;
const DIE = { x: -58, y: -20, w: 44, d: 40, r: 3 };
const DIE_Z = 24;
const TRAY = { x: 14, y: -18, w: 68, d: 36, r: 3 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners(HEAD, HEAD_Z, HEAD_Z + HEAD_H + 6),
]);

const posts = byDepth(corners(BED, 7), s);
const column = ([x, y]: [number, number]) =>
	s.solid(cylinder(x, y, 3.5, BED_H, HEAD_Z - BED_H, s.P, 20));

benchPlate(s, PLATE);
s.halo(BED, 0);
s.solid(slabOf(BED, 0, BED_H, s.P, 6, 0.8));
for (const post of posts.slice(0, 2)) {
	column(post);
}
// The mockup on the bed: a sheet with its layout blocked in.
const sheet = { x: -60, y: -22, w: 48, d: 44, r: 1 };
s.solid(slabOf(sheet, BED_H, 1, s.P, 2), { crease: "none" });
s.line(planOutline({ x: -56, y: -18, w: 40, d: 10, r: 1 }, BED_H + 1, s.P, 2), {
	tone: "lo",
});
s.line(planOutline({ x: -56, y: -4, w: 18, d: 22, r: 1 }, BED_H + 1, s.P, 2), {
	tone: "lo",
});
s.line(planOutline({ x: -34, y: -4, w: 18, d: 22, r: 1 }, BED_H + 1, s.P, 2), {
	tone: "lo",
});
// Ram and die above it.
s.solid(slabOf(DIE, DIE_Z, 8, s.P, 4, 0.6), { tone: "lo" });
s.solid(cylinder(-36, 0, 7, DIE_Z + 8, HEAD_Z - DIE_Z - 8, s.P, 28));
for (const post of posts.slice(2)) {
	column(post);
}
s.solid(slabOf(HEAD, HEAD_Z, HEAD_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(HEAD, 5), HEAD_Z + HEAD_H, s.P, 4), {
	tone: "faint",
});
screws(s, corners(HEAD, 7), HEAD_Z + HEAD_H, 1.6);
// Token selector knobs on the crosshead.
knob(s, [-62, -12], HEAD_Z + HEAD_H, 4, 5);
knob(s, [-44, 10], HEAD_Z + HEAD_H, 4, 5);
// Run-out tray with the pressed component on it.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 4, s.P, 4, 0.6), { tone: "lo" });
s.line(planOutline(insetPlan(TRAY, 3), 4, s.P, 3), { tone: "faint" });
const part = { x: 40, y: -11, w: 32, d: 22, r: 2 };
s.halo(part, 4);
s.solid(slabOf(part, 4, 6, s.P, 3, 0.6), { lit: true });
s.solid(slabOf({ x: 44, y: -7, w: 14, d: 6, r: 1 }, 10, 2, s.P, 2), {
	tone: "lo",
});
s.solid(slabOf({ x: 60, y: 2, w: 8, d: 5, r: 2 }, 10, 2, s.P, 2), {
	tone: "lo",
});

export const drawing = cardDrawing(s);
