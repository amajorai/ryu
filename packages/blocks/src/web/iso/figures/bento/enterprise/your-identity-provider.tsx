import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Your identity provider: a badge reader on the bench. Your own badge stands
 * in its slot (the lit card), and beside it a rack holds the badges your
 * directory has already issued: sign-in at the reader, provisioning in the rack.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const READER = { x: -78, y: -30, w: 48, d: 48, r: 5 };
const READER_H = 26;
const RACK = { x: 4, y: -34, w: 72, d: 70, r: 4 };
const RACK_H = 8;
const BADGE_H = 26;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-54, -6, READER_H + BADGE_H],
	[40, -30, RACK_H + BADGE_H],
]);

function badge(x: number, y: number, z: number, lit = false) {
	const plan = { x, y, w: 30, d: 3, r: 0.8 };
	s.solid(slabOf(plan, z, BADGE_H, s.P, 2), { lit });
	// The clip on top of the card.
	s.solid(
		slabOf({ x: x + 11, y: y - 0.5, w: 8, d: 4, r: 1 }, z + BADGE_H, 3, s.P, 2),
		{
			tone: "lo",
		}
	);
}

benchPlate(s, PLATE);
// Reader: a console with a slot and a ready lamp.
s.halo(READER, 0);
s.solid(slabOf(READER, 0, READER_H, s.P, 6, 1));
s.line(planOutline(insetPlan(READER, 5), READER_H, s.P, 4), { tone: "faint" });
const slot = { x: READER.x + 7, y: READER.y + 20, w: 34, d: 6, r: 1.5 };
s.line(planOutline(slot, READER_H, s.P, 2), { tone: "mid" });
lamp(s, [READER.x + 40, READER.y + 9], READER_H, { radius: 1.8 });
screws(s, [[READER.x + 8, READER.y + 40]], READER_H, 1.4);
badge(READER.x + 9, READER.y + 21.5, READER_H, true);
// Provisioning rack: a low tray with a row of issued badges.
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(RACK, 4), RACK_H, s.P, 3), { tone: "faint" });
for (let i = 0; i < 4; i++) {
	const y = RACK.y + 10 + i * 15;
	s.line(
		lineOnTop([RACK.x + 8, y - 1], [RACK.x + RACK.w - 8, y - 1], RACK_H, s.P),
		{
			tone: "lo",
		}
	);
	badge(RACK.x + 21, y, RACK_H);
}

export const drawing = cardDrawing(s);
