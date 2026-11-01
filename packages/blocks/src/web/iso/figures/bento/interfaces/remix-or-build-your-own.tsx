import {
	boxCorners,
	corners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Remix or build your own: a small mixing desk. Each channel is one setting,
 * a trim knob on top and a fader below, pushed to its own level; the channel
 * being changed has its lamp lit. Same desk, different mix.
 */

const PLATE = { x: -92, y: -54, w: 184, d: 108, r: 8 };
const DESK = { x: -70, y: -44, w: 140, d: 84, r: 6 };
const DESK_H = 12;
const CHANNELS = [-52, -32, -12, 8, 28, 48];
const LEVELS = [0.7, 0.35, 0.85, 0.2, 0.55, 0.45];
const LIT = 2;
const SLOT_Y = -14;
const SLOT_D = 44;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, DESK_H + 12]]);

benchPlate(s, PLATE);
s.halo(DESK, 0);
s.solid(slabOf(DESK, 0, DESK_H, s.P, 6, 1));
s.line(planOutline(insetPlan(DESK, 4), DESK_H, s.P, 4), { tone: "faint" });
screws(s, corners(DESK, 7), DESK_H, 1.3);
for (const [index, x] of CHANNELS.entries()) {
	knob(s, [x, -32], DESK_H, 3.6, 3.5);
	lamp(s, [x + 7, -24], DESK_H, { lit: index === LIT, radius: 1.3 });
	s.line(
		planOutline(
			{ x: x - 1.5, y: SLOT_Y, w: 3, d: SLOT_D, r: 1.5 },
			DESK_H,
			s.P,
			3
		),
		{ tone: "mid" }
	);
	for (let tick = 0; tick <= 4; tick++) {
		const y = SLOT_Y + (SLOT_D * tick) / 4;
		s.line(lineOnTop([x + 4, y], [x + 6.5, y], DESK_H, s.P), { tone: "faint" });
	}
	const y = SLOT_Y + SLOT_D * (1 - (LEVELS[index] ?? 0)) - 4;
	s.solid(
		slabOf({ x: x - 5, y, w: 10, d: 8, r: 1.5 }, DESK_H, 5, s.P, 3, 0.5),
		index === LIT ? { lit: true } : {}
	);
	s.line(lineOnTop([x - 3.5, y + 4], [x + 3.5, y + 4], DESK_H + 5, s.P), {
		tone: "lo",
	});
}

export const drawing = cardDrawing(s);
