import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRules, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Saved prompts: a rack of cartridges, the library. One has been taken out
 * and pushed into the reader beside it (the lit cartridge), which plays it
 * onto the page in the delivery tray at its foot: any page, the same prompt.
 */

const PLATE = { x: -98, y: -50, w: 190, d: 104, r: 8 };
const RACK = { x: -86, y: -36, w: 74, d: 50, r: 4 };
const RACK_H = 8;
const READER = { x: 4, y: -40, w: 64, d: 42, r: 5 };
const READER_H = 26;
const PLATEN = { x: 0, y: 4, w: 76, d: 38, r: 3 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[36, -20, READER_H + 16],
	[-50, -10, RACK_H + 28],
]);

benchPlate(s, PLATE);
// The library rack: a slotted base with upright cartridges and one gap.
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 6, 0.8));
for (let i = 0; i < 5; i++) {
	const x = RACK.x + 7 + i * 13;
	const plan = { x, y: RACK.y + 6, w: 8, d: 38, r: 1 };
	if (i === 3) {
		s.line(planOutline(plan, RACK_H, s.P, 2), { tone: "mid" });
		continue;
	}
	s.solid(slabOf(plan, RACK_H, 26, s.P, 3, 0.4));
	s.line(
		lineOnTop([x + 4, plan.y + 6], [x + 4, plan.y + 20], RACK_H + 26, s.P),
		{ tone: "lo" }
	);
}
faceRules(s, "y", RACK.y + RACK.d, RACK.x + 8, 6, [24], 3);
// The reader: a deck with a top slot, the chosen cartridge pushed in.
s.halo(READER, 0);
s.solid(slabOf(READER, 0, READER_H, s.P, 6, 1));
s.line(planOutline(insetPlan(READER, 5), READER_H, s.P, 6), { tone: "faint" });
const slot = { x: 30, y: READER.y + 8, w: 10, d: 26, r: 1 };
s.line(planOutline(slot, READER_H, s.P, 2), { tone: "mid" });
s.solid(
	slabOf(
		{ x: 31, y: slot.y + 2, w: 8, d: 22, r: 1 },
		READER_H,
		14,
		s.P,
		3,
		0.4
	),
	{
		lit: true,
	}
);
lamp(s, [READER.x + 10, READER.y + READER.d - 10], READER_H, { radius: 1.8 });
screws(s, [[READER.x + READER.w - 9, READER.y + READER.d - 8]], READER_H, 1.4);
faceRules(s, "y", READER.y + READER.d, READER.x + 10, 18, [30, 20], 4);
// The platen in front, carrying the page the prompt runs on.
s.halo(PLATEN, 0);
s.solid(slabOf(PLATEN, 0, 4, s.P, 4, 0.6), { tone: "lo" });
const sheet = insetPlan(PLATEN, 4);
s.solid(slabOf(sheet, 4, 1.2, s.P, 3), { crease: "none" });
for (const [i, reach] of [56, 44, 50].entries()) {
	const y = sheet.y + 6 + i * 7;
	s.line(lineOnTop([sheet.x + 6, y], [sheet.x + reach, y], 5.2, s.P), {
		tone: i === 0 ? "mid" : "lo",
	});
}

export const drawing = cardDrawing(s);
