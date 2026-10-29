import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Infra as code edits: an arbor press with its ram held up. The change is
 * laid out under it as a marked-up plan sheet (the lit part), in a template
 * tray, to be read before the lever is pulled and anything is pressed.
 */

const PLATE = { x: -60, y: -58, w: 132, d: 108, r: 8 };
const BASE = { x: -44, y: -46, w: 84, d: 84, r: 5 };
const BASE_H = 8;
const COLUMN = { x: -14, y: -44, w: 20, d: 16, r: 2 };
const TOP = 74;
const ARM = { x: -12, y: -44, w: 16, d: 46, r: 3 };
const RAM: [number, number] = [-4, -10];
const TRAY = { x: -30, y: -24, w: 52, d: 46, r: 3 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, -40, TOP + 6]]);

benchPlate(s, PLATE);
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 1));
screws(
	s,
	[
		[BASE.x + 7, BASE.y + 7],
		[BASE.x + BASE.w - 7, BASE.y + BASE.d - 7],
		[BASE.x + 7, BASE.y + BASE.d - 7],
	],
	BASE_H,
	1.6
);
// The column at the back.
s.solid(slabOf(COLUMN, BASE_H, TOP - 12 - BASE_H, s.P, 4, 0.8));
// Template tray and the plan sheet waiting in it.
s.halo(TRAY, BASE_H);
s.solid(slabOf(TRAY, BASE_H, 3, s.P, 4, 0.6), { tone: "lo" });
const sheet = insetPlan(TRAY, 6);
s.solid(slabOf(sheet, BASE_H + 3, 1, s.P, 2), { lit: true, crease: "none" });
const sheetZ = BASE_H + 4;
for (let i = 0; i < 4; i++) {
	const y = sheet.y + 7 + i * 7;
	s.line(
		lineOnTop(
			[sheet.x + 5, y],
			[sheet.x + 5 + ([28, 20, 24, 14][i] ?? 20), y],
			sheetZ,
			s.P
		),
		{
			tone: i === 2 ? "mid" : "lo",
		}
	);
}
// The ram hangs from the head, well clear of the tray.
s.solid(cylinder(RAM[0], RAM[1], 3.4, 40, TOP - 12 - 40, s.P, 20));
s.solid(cylinder(RAM[0], RAM[1], 9, 36, 4, s.P, 32, 0.6));
s.line(ring(RAM[0], RAM[1], 5, 36, s.P, 24), { tone: "faint" });
// Head and the lever off its side.
s.solid(slabOf(ARM, TOP - 12, 12, s.P, 4, 1));
s.line(planOutline(insetPlan(ARM, 3), TOP, s.P, 3), { tone: "faint" });
s.solid(cylinder(ARM.x + ARM.w + 2, -22, 5, TOP - 10, 8, s.P, 24), {
	tone: "lo",
});
s.solid(
	slabOf(
		{ x: ARM.x + ARM.w + 4, y: -24, w: 44, d: 4, r: 1 },
		TOP - 8,
		4,
		s.P,
		2
	)
);
s.solid(cylinder(ARM.x + ARM.w + 50, -22, 5, TOP - 10, 8, s.P, 24, 1.2));
lamp(s, [ARM.x + 8, ARM.y + 6], TOP, { radius: 1.8 });

export const drawing = cardDrawing(s);
