import {
	boxCorners,
	cylinder,
	extrude,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Ticket triage: a sorting hopper. Tickets come up out of the intake slot at
 * the back; a pivoting sorter arm swings each one over a priority bin. The
 * urgent bin (three lamps) has just taken the newest ticket (lit), with its
 * first reply drafted, for an agent to pick up.
 */

const PLATE = { x: -96, y: -52, w: 160, d: 104, r: 8 };
const HOPPER = { x: -84, y: -42, w: 52, d: 36, r: 4 };
const HOPPER_H = 30;
const BIN_H = 18;
const PIVOT: [number, number] = [-12, -22];
const REACH: [number, number] = [-58, 20];
const ARM_Z = 34;

/** A flat bar from `from` to `to`, `width` wide, as a convex plan ring. */
function bar(from: [number, number], to: [number, number], width: number) {
	const [ax, ay] = from;
	const [bx, by] = to;
	const length = Math.hypot(bx - ax, by - ay);
	const nx = (-(by - ay) / length) * (width / 2);
	const ny = ((bx - ax) / length) * (width / 2);
	return [
		[ax + nx, ay + ny],
		[bx + nx, by + ny],
		[bx - nx, by - ny],
		[ax - nx, ay - ny],
	] as [number, number][];
}

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-58, -24, HOPPER_H + 16],
]);

function bin(x: number, rank: number, lit = false) {
	const plan = { x, y: 4, w: 40, d: 36, r: 3 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, BIN_H, s.P, 4, 0.6));
	s.line(planOutline(insetPlan(plan, 3), BIN_H, s.P, 3), { tone: "lo" });
	// Tickets filed on end inside the bin, the front one the newest.
	const cards = lit ? 3 : 2;
	for (let i = 0; i < cards; i++) {
		s.solid(
			slabOf(
				{ x: x + 8, y: plan.y + 8 + i * 7, w: 24, d: 2, r: 0.4 },
				BIN_H - 6,
				i === cards - 1 && lit ? 18 : 10,
				s.P,
				2
			),
			{ lit: lit && i === cards - 1, crease: "none" }
		);
	}
	for (let i = 0; i < rank; i++) {
		lamp(s, [x + 32 - i * 6, plan.y + plan.d - 4], BIN_H, { radius: 1.4 });
	}
}

benchPlate(s, PLATE);
// Intake hopper with tickets standing up out of its slot.
s.halo(HOPPER, 0);
s.solid(slabOf(HOPPER, 0, HOPPER_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(HOPPER, 4), HOPPER_H, s.P, 4), {
	tone: "faint",
});
const slot = { x: -74, y: -26, w: 32, d: 4, r: 1 };
s.line(planOutline(slot, HOPPER_H, s.P, 2), { tone: "mid" });
s.solid(slabOf({ x: -72, y: -25, w: 28, d: 2, r: 0.4 }, HOPPER_H, 14, s.P, 2), {
	crease: "none",
});
screws(
	s,
	[
		[HOPPER.x + 6, HOPPER.y + 6],
		[HOPPER.x + HOPPER.w - 6, HOPPER.y + 6],
	],
	HOPPER_H,
	1.4
);
// Sorter: a post with a swinging arm reaching over the urgent bin.
s.halo({ x: PIVOT[0] - 9, y: PIVOT[1] - 9, w: 18, d: 18, r: 9 }, 0);
s.solid(cylinder(PIVOT[0], PIVOT[1], 9, 0, 4, s.P, 28, 0.6), { tone: "lo" });
s.solid(cylinder(PIVOT[0], PIVOT[1], 4, 4, ARM_Z - 4, s.P, 24));
s.solid(cylinder(PIVOT[0], PIVOT[1], 6, ARM_Z - 2, 7, s.P, 24), { tone: "lo" });
knob(s, [36, -30], 0, 6, 8);
bin(-80, 3, true);
bin(-34, 2);
bin(12, 1);
// The arm drawn over the urgent bin, its finger dropping toward the card.
s.solid(extrude(bar(PIVOT, REACH, 6), ARM_Z, 4, s.P, { convex: true }));
s.solid(cylinder(REACH[0], REACH[1], 2.4, ARM_Z - 3, 3, s.P, 16), {
	tone: "lo",
});

export const drawing = cardDrawing(s);
