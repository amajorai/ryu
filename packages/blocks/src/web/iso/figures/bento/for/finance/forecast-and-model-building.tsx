import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, ruler, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Forecast and model building: a driver console with three set knobs beside a
 * screw press. The model block (lit) sits under the platen while the press
 * loads it, the stress test an analyst reads before trusting the forecast.
 */

const PLATE = { x: -100, y: -52, w: 200, d: 104, r: 8 };
const CONSOLE = { x: -88, y: -40, w: 70, d: 80, r: 4 };
const CONSOLE_H = 12;
const BASE = { x: 2, y: -32, w: 84, d: 64, r: 4 };
const BASE_H = 6;
const BAR_Z = 58;
const CX = 44;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [CX, 0, BAR_Z + 14]]);

benchPlate(s, PLATE);
// Driver console: three knobs set to the assumptions, a ruler for the range.
s.halo(CONSOLE, 0);
s.solid(slabOf(CONSOLE, 0, CONSOLE_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(CONSOLE, 5), CONSOLE_H, s.P, 4), {
	tone: "faint",
});
for (const [i, y] of [-24, -2, 20].entries()) {
	knob(s, [CONSOLE.x + 20, y], CONSOLE_H, 6, 6 + i);
	s.line(ring(CONSOLE.x + 20, y, 9.5, CONSOLE_H, s.P, 32), { tone: "faint" });
}
ruler(s, { x: CONSOLE.x + 40, y: -30, w: 10, d: 60, r: 1 }, CONSOLE_H, "y");
// Press base, two posts, the model block under the platen.
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 0.8));
screws(
	s,
	[
		[BASE.x + 8, BASE.y + 8],
		[BASE.x + BASE.w - 8, BASE.y + BASE.d - 8],
	],
	BASE_H,
	1.6
);
s.solid(cylinder(12, 0, 4, BASE_H, BAR_Z - BASE_H, s.P, 24));
s.solid(cylinder(CX, 0, 3, 34, BAR_Z - 34, s.P, 20), { tone: "lo" });
s.halo({ x: CX - 15, y: -13, w: 30, d: 26, r: 3 }, BASE_H);
s.solid(
	slabOf({ x: CX - 14, y: -12, w: 28, d: 24, r: 2 }, BASE_H, 22, s.P, 4),
	{
		lit: true,
	}
);
s.solid(
	slabOf(
		{ x: CX - 18, y: -15, w: 36, d: 30, r: 3 },
		BASE_H + 22,
		6,
		s.P,
		4,
		0.6
	)
);
s.solid(cylinder(76, 0, 4, BASE_H, BAR_Z - BASE_H, s.P, 24));
// Crossbar and handwheel.
s.solid(slabOf({ x: 4, y: -8, w: 80, d: 16, r: 3 }, BAR_Z, 8, s.P, 4, 0.8));
s.solid(cylinder(CX, 0, 13, BAR_Z + 8, 4, s.P, 40, 0.5));
s.line(knurl(CX, 0, 13, BAR_Z + 8, BAR_Z + 12, 40, s.P), { tone: "lo" });
s.solid(cylinder(CX, 0, 3.5, BAR_Z + 12, 2, s.P, 20), { tone: "lo" });

export const drawing = cardDrawing(s);
