import { type Plan, slabOf } from "../../../../kit/iso-kit.ts";
import type { Sketch } from "../../../static/sketch.tsx";

/*
 * Paper parts shared by the paralegal cards: a ream of loose sheets, each a
 * thin slab nudged off the one below so the stack reads as paper.
 */

/** Stack `count` sheets on `plan` from `z`; returns the top of the stack. */
export function sheetStack(
	s: Sketch,
	plan: Plan,
	z: number,
	count: number,
	{ thick = 1.6, shift = 1.2 } = {}
): number {
	let top = z;
	for (let i = 0; i < count; i++) {
		const nudge = ((i % 3) - 1) * shift;
		s.solid(
			slabOf(
				{ ...plan, x: plan.x + nudge, y: plan.y - nudge * 0.6 },
				top,
				thick,
				s.P,
				2
			),
			{ crease: "none" }
		);
		top += thick;
	}
	return top;
}
