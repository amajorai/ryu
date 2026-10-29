import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	radialTicks,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, knob, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Runbook automation: a segment timer. The steps are pins pushed up around a
 * turning dial; as each reaches the trip finger it throws the next switch on
 * the bank beside it. The pin at the finger (lit) is the step running now.
 */

const PLATE = { x: -84, y: -62, w: 184, d: 112, r: 8 };
const CENTER: [number, number] = [-16, -8];
const HOUSING = { x: CENTER[0] - 42, y: CENTER[1] - 42, w: 84, d: 84, r: 10 };
const HOUSING_H = 12;
const R = 34;
const DISC_H = 4;
const PINS = 24;
const RAISED = [2, 3, 4, 7, 9, 13, 14, 18, 19];
const NOW = 9;
const BANK = { x: 44, y: -34, w: 40, d: 34, r: 4 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, 30]]);

// The same angle convention as the kit's radial ticks: 0 points to -y.
const polar = (angle: number, radius: number): [number, number] => [
	CENTER[0] + Math.sin(angle) * radius,
	CENTER[1] - Math.cos(angle) * radius,
];

benchPlate(s, PLATE);
// Timer housing and the turning dial.
s.halo(HOUSING, 0);
s.solid(slabOf(HOUSING, 0, HOUSING_H, s.P, 8, 1));
const top = HOUSING_H + DISC_H;
s.solid(cylinder(CENTER[0], CENTER[1], R, HOUSING_H, DISC_H, s.P, 64, 0.8));
const ticks = radialTicks(CENTER[0], CENTER[1], R - 1, 48, 4, top, [2, 4], s.P);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
const pins: [number, number, number][] = [];
for (let i = 0; i < PINS; i++) {
	if (RAISED.includes(i)) {
		const [x, y] = polar((i / PINS) * Math.PI * 2, R - 9);
		pins.push([x, y, i]);
	}
}
for (const [x, y, i] of byDepth(pins, s, top)) {
	s.solid(cylinder(x, y, 2.4, top, 6, s.P, 16), { lit: i === NOW });
}
knob(s, CENTER, top, 9, 7);
// The trip finger, fixed to the housing at the pin now running.
const [fx, fy] = polar((NOW / PINS) * Math.PI * 2, R + 4);
s.solid(
	slabOf({ x: fx - 3, y: fy - 3, w: 6, d: 6, r: 1 }, HOUSING_H, 10, s.P, 2),
	{
		tone: "lo",
	}
);
// Switch bank to the near side, drawn after the timer: three toggles, three lamps.
s.halo(BANK, 0);
s.solid(slabOf(BANK, 0, 14, s.P, 4, 0.8));
s.line(planOutline(insetPlan(BANK, 4), 14, s.P, 3), { tone: "faint" });
for (let i = 0; i < 3; i++) {
	const x = BANK.x + 9 + i * 11;
	lamp(s, [x, BANK.y + 8], 14, { radius: 1.6 });
	s.solid(cylinder(x, BANK.y + 22, 3, 14, 1.4, s.P, 20), { tone: "lo" });
	s.solid(
		slabOf(
			{ x: x - 1, y: BANK.y + (i === 0 ? 22 : 16), w: 2, d: 6, r: 0.5 },
			15.4,
			5,
			s.P,
			2
		)
	);
}

export const drawing = cardDrawing(s);
