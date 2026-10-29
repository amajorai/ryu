import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Mute and silence: a desk bell with a felt damper lowered onto its dome (the
 * lit pad), so a repeat ring makes no sound, beside a bank of mute switches,
 * one per recipient, some thrown.
 */

const PLATE = { x: -96, y: -52, w: 192, d: 104, r: 8 };
const BELL: [number, number] = [-40, 6];
const POST = { x: -46, y: -42, w: 12, d: 12, r: 2 };
const BANK = { x: 22, y: -36, w: 52, d: 72, r: 4 };
const BANK_H = 10;

const DOME = [
	[26, 6],
	[23, 5],
	[18, 4],
	[11, 3],
] as const;
const DOME_TOP = 8 + DOME.reduce((sum, [, h]) => sum + h, 0);
const PAD_TOP = DOME_TOP + 4;
const ARM_TOP = PAD_TOP + 4;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-40, -36, ARM_TOP]]);

benchPlate(s, PLATE);
// Damper post at the back.
s.halo(POST, 0);
s.solid(slabOf(POST, 0, ARM_TOP, s.P, 4, 0.6));
// The bell: a round base, a short stem and a stepped dome.
s.halo({ x: BELL[0] - 32, y: BELL[1] - 32, w: 64, d: 64, r: 32 }, 0);
s.solid(cylinder(BELL[0], BELL[1], 32, 0, 5, s.P, 56, 0.6), { tone: "lo" });
s.solid(cylinder(BELL[0], BELL[1], 4, 5, 3, s.P, 20));
let z = 8;
for (const [index, [radius, height]] of DOME.entries()) {
	s.solid(cylinder(BELL[0], BELL[1], radius, z, height, s.P, 56, 0.4));
	z += height;
	if (index === 0) {
		// A turned groove on the first step, outside the next one.
		s.line(ring(BELL[0], BELL[1], 24.5, z, s.P, 48), { tone: "faint" });
	}
}
// Felt pad pressed onto the dome, held by the arm.
s.solid(cylinder(BELL[0], BELL[1], 7, DOME_TOP, 4, s.P, 28), { lit: true });
s.solid(
	slabOf(
		{ x: BELL[0] - 3, y: POST.y + 3, w: 6, d: BELL[1] - POST.y, r: 1 },
		PAD_TOP,
		4,
		s.P,
		2
	)
);
// Mute bank: four rocker switches in slots.
s.halo(BANK, 0);
s.solid(slabOf(BANK, 0, BANK_H, s.P, 5, 0.6));
s.line(planOutline(insetPlan(BANK, 4), BANK_H, s.P, 4), { tone: "faint" });
const thrown = [false, true, false, true];
thrown.forEach((off, index) => {
	const y = BANK.y + 10 + index * 15;
	const slot = { x: BANK.x + 10, y, w: 24, d: 9, r: 2 };
	s.line(planOutline(slot, BANK_H, s.P, 3), { tone: "lo" });
	s.solid(
		slabOf(
			{ x: off ? slot.x + 12 : slot.x + 1, y: y + 1, w: 11, d: 7, r: 1.5 },
			BANK_H,
			5,
			s.P,
			3,
			0.4
		),
		{
			tone: off ? "lo" : "mid",
		}
	);
	screws(s, [[BANK.x + BANK.w - 10, y + 4.5]], BANK_H, 1.4);
});

export const drawing = cardDrawing(s);
