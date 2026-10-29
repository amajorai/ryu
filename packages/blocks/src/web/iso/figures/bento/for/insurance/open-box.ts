import { type Plan, slabOf } from "../../../../kit/iso-kit.ts";
import type { Sketch } from "../../../static/sketch.tsx";

/*
 * An open-topped box (a bin, a drawer) drawn in painter's order: floor, back
 * and left walls, then whatever stands inside, then the right and front walls
 * that hide its lower part.
 */
export function openBox(
	s: Sketch,
	plan: Plan,
	z: number,
	height: number,
	inside: () => void,
	{ wall = 2.5, tone = "mid" as "mid" | "lo" } = {}
) {
	const { x, y, w, d } = plan;
	s.solid(slabOf({ x, y, w, d, r: 1 }, z, 2, s.P, 3, 0.4), { tone });
	s.solid(slabOf({ x, y, w, d: wall, r: 0.5 }, z, height, s.P, 2), { tone });
	s.solid(slabOf({ x, y, w: wall, d, r: 0.5 }, z, height, s.P, 2), { tone });
	inside();
	s.solid(
		slabOf({ x: x + w - wall, y, w: wall, d, r: 0.5 }, z, height, s.P, 2),
		{
			tone,
		}
	);
	s.solid(
		slabOf({ x, y: y + d - wall, w, d: wall, r: 0.5 }, z, height, s.P, 2),
		{
			tone,
		}
	);
}
