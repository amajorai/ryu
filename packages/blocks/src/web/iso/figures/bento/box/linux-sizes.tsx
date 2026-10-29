import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	radialTicks,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRules,
	knob,
	lamp,
	ruler,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Linux sizes: three machine blocks lined up small, default and large on a
 * ruled bench, with a three-stop size selector beside them. The large block,
 * the most one Box can be (8 vCPU, 16 GiB), has its lamp on (the lit part).
 */

const PLATE = { x: -100, y: -46, w: 200, d: 92, r: 8 };
const FRONT = 24;
const UNITS = [
	{ x: -88, w: 34, d: 36, h: 18 },
	{ x: -48, w: 42, d: 46, h: 30 },
	{ x: 0, w: 52, d: 60, h: 44 },
];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [26, -10, 46]]);

benchPlate(s, PLATE);
// Halos first, so a nearer block's shadow never paints over a farther block.
for (const { x, w, d } of UNITS) {
	s.halo({ x, y: FRONT - d, w, d, r: 4 }, 0);
}
UNITS.forEach(({ x, w, d, h }, index) => {
	const plan = { x, y: FRONT - d, w, d, r: 4 };
	s.solid(slabOf(plan, 0, h, s.P, 5, 0.8));
	s.line(planOutline(insetPlan(plan, 4), h, s.P, 4), { tone: "faint" });
	const rows = Math.round(h / 8);
	faceRules(s, "y", FRONT, x + 6, h - 6, new Array(rows).fill(w - 20), 5);
	lamp(s, [x + w - 8, FRONT - 8], h, {
		lit: index === UNITS.length - 1,
		radius: index === UNITS.length - 1 ? 2.4 : 1.8,
	});
});
ruler(s, { x: -88, y: FRONT + 6, w: 140, d: 9, r: 1 });
// Size selector: a dial with three stops on its own base.
s.halo({ x: 63, y: 5, w: 30, d: 30, r: 15 }, 0);
s.solid(cylinder(78, 20, 14, 0, 6, s.P, 40, 0.6));
const stops = radialTicks(78, 20, 11, 3, 1, 6, [2, 3], s.P, -0.9, 1.8);
s.line(stops.major, { tone: "mid" });
knob(s, [78, 20], 6, 6, 6);

export const drawing = cardDrawing(s);
