import {
	boxCorners,
	cylinder,
	extrude,
	lineOnTop,
	type Plan,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRules, knob, lamp } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Harmful output: a sorting line. Replies drop from the hopper onto a
 * conveyor; at its end a diverter paddle is swung across the pass bin, so the
 * reply that failed the check lands in the reject bin (the lit block).
 */

const PLATE = { x: -90, y: -54, w: 182, d: 78, r: 8 };
const TOWER = { x: -80, y: -40, w: 36, d: 36, r: 3 };
const TOWER_H = 34;
const HOP: [number, number] = [TOWER.x + 18, TOWER.y + 18];
const BELT = { x: -44, y: -30, w: 88, d: 16, r: 2 };
const BELT_Z = 18;
const BELT_H = 5;
const BIN_H = 11;
const WALL = 2.4;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[HOP[0], HOP[1], 58],
]);

/** An open bin: floor and walls, with something inside drawn in between. */
function bin(plan: Plan, inside: () => void) {
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, 2, s.P, 3), { tone: "lo" });
	s.solid(slabOf({ ...plan, d: WALL, r: 0.5 }, 0, BIN_H, s.P, 2));
	s.solid(slabOf({ ...plan, w: WALL, r: 0.5 }, 0, BIN_H, s.P, 2));
	inside();
	s.solid(
		slabOf(
			{ ...plan, x: plan.x + plan.w - WALL, w: WALL, r: 0.5 },
			0,
			BIN_H,
			s.P,
			2
		)
	);
	s.solid(
		slabOf(
			{ ...plan, y: plan.y + plan.d - WALL, d: WALL, r: 0.5 },
			0,
			BIN_H,
			s.P,
			2
		)
	);
}

function reply(x: number, y: number, z: number, lit = false) {
	const plan = { x: x - 5, y: y - 5, w: 10, d: 10, r: 1.5 };
	s.solid(slabOf(plan, z, 8, s.P, 3, 0.5), { lit });
}

benchPlate(s, PLATE);
// Hopper tower: a cabinet with a stepped funnel on top.
s.halo(TOWER, 0);
s.solid(slabOf(TOWER, 0, TOWER_H, s.P, 4, 0.8));
faceRules(s, "y", TOWER.y + TOWER.d, TOWER.x + 6, TOWER_H - 8, [20, 14, 18], 4);
knob(s, [TOWER.x + 30, TOWER.y + 30], TOWER_H, 3.2, 3);
s.solid(cylinder(HOP[0], HOP[1], 7, TOWER_H, 6, s.P, 28), { tone: "lo" });
s.solid(cylinder(HOP[0], HOP[1], 11, TOWER_H + 6, 6, s.P, 32));
s.solid(cylinder(HOP[0], HOP[1], 15, TOWER_H + 12, 8, s.P, 36, 0.6));
// Conveyor on two legs, with roller lines across the belt.
for (const x of [BELT.x + 14, BELT.x + BELT.w - 10]) {
	s.solid(cylinder(x, BELT.y + BELT.d / 2, 3, 0, BELT_Z, s.P, 16));
}
s.solid(slabOf(BELT, BELT_Z, BELT_H, s.P, 3, 0.6));
const top = BELT_Z + BELT_H;
for (let x = BELT.x + 6; x < BELT.x + BELT.w - 2; x += 8) {
	s.line(lineOnTop([x, BELT.y + 2], [x, BELT.y + BELT.d - 2], top, s.P), {
		tone: "faint",
	});
}
reply(-22, BELT.y + 8, top);
reply(8, BELT.y + 8, top);
reply(32, BELT.y + 8, top);
// Pass bin behind; the diverter paddle is swung across its mouth.
bin({ x: 50, y: -46, w: 36, d: 28, r: 1 }, () => {
	reply(68, -32, 2);
});
const PIVOT: [number, number] = [48, -14];
s.solid(cylinder(PIVOT[0], PIVOT[1], 2.6, 0, 30, s.P, 16), { tone: "lo" });
const angle = -0.75;
const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
const [nx, ny] = [-uy * 1.5, ux * 1.5];
const tip: [number, number] = [PIVOT[0] + ux * 34, PIVOT[1] + uy * 34];
s.solid(
	extrude(
		[
			[PIVOT[0] - nx, PIVOT[1] - ny],
			[tip[0] - nx, tip[1] - ny],
			[tip[0] + nx, tip[1] + ny],
			[PIVOT[0] + nx, PIVOT[1] + ny],
		],
		BIN_H + 2,
		10,
		s.P
	)
);
s.solid(cylinder(PIVOT[0], PIVOT[1], 4, 26, 4, s.P, 20));
// Reject bin in front, holding the reply that failed.
bin({ x: 50, y: -10, w: 36, d: 28, r: 1 }, () => {
	reply(72, 0, 2);
	reply(62, 6, 2);
	reply(66, 2, 10, true);
});
lamp(s, [-78, 12], 0, { radius: 2 });

export const drawing = cardDrawing(s);
