import {
	boxCorners,
	insetPlan,
	type Point3,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRules, jack, lamp } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Track every source: a patch bay. Each installed skill (a module in the near
 * row) is cabled back to the source post it came from; when a source changes,
 * its module's lamp lights (the lit lamp) to say an update is waiting.
 */

const PLATE = { x: -92, y: -56, w: 184, d: 112, r: 8 };
const POST_H = 30;
const MOD_H = 14;
const LANES = [-54, 0, 54];
const POST_Y = -36;
const MOD_Y = 22;
const CHANGED = 1;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-78, POST_Y - 10, POST_H + 14],
]);

benchPlate(s, PLATE);
// The source rack at the back: one post per source, each with its jack.
const RACK = { x: -78, y: POST_Y - 10, w: 156, d: 20, r: 3 };
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, POST_H, s.P, 4, 0.8));
s.line(planOutline(insetPlan(RACK, 3), POST_H, s.P, 3), { tone: "faint" });
for (const x of LANES) {
	faceRules(s, "y", RACK.y + RACK.d, x - 12, POST_H - 7, [22, 14, 18], 5);
	jack(s, [x, POST_Y], POST_H);
}
// Installed modules on a common tray in the near row, each with its lamp.
const TRAY = { x: -80, y: MOD_Y - 17, w: 160, d: 34, r: 3 };
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 4, s.P, 4, 0.6), { tone: "lo" });
for (const [index, x] of LANES.entries()) {
	const mod = { x: x - 18, y: MOD_Y - 13, w: 36, d: 26, r: 3 };
	s.halo(mod, 4, 3);
	s.solid(slabOf(mod, 4, MOD_H, s.P, 4, 0.8));
	s.line(planOutline(insetPlan(mod, 3), MOD_H + 4, s.P, 3), {
		tone: "faint",
	});
	jack(s, [x - 8, MOD_Y - 4], MOD_H + 4);
	lamp(s, [x + 8, MOD_Y + 4], MOD_H + 4, {
		lit: index === CHANGED,
		radius: 3,
	});
}
// Cables from each source jack, arcing forward and down to its module.
type Controls = [Point3, Point3, Point3, Point3];
const bezier = ([a, b, c, d]: Controls, t: number): Point3 => {
	const u = 1 - t;
	const mix = (axis: 0 | 1 | 2) =>
		u * u * u * a[axis] +
		3 * u * u * t * b[axis] +
		3 * u * t * t * c[axis] +
		t * t * t * d[axis];
	return [mix(0), mix(1), mix(2)];
};
for (const x of LANES) {
	const from: Point3 = [x, POST_Y, POST_H];
	const to: Point3 = [x - 8, MOD_Y - 4, MOD_H + 4];
	const controls: Controls = [
		from,
		[x, POST_Y + 2, POST_H + 14],
		[x - 8, MOD_Y - 10, MOD_H + 20],
		to,
	];
	const via = Array.from({ length: 11 }, (_, index) =>
		bezier(controls, (index + 1) / 12)
	);
	s.wire(from, to, via, { tone: "mid" });
}
export const drawing = cardDrawing(s);
