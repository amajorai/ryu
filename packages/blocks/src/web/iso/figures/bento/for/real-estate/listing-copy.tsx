import {
	boxCorners,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRules,
	knob,
	lamp,
	ruler,
} from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";
import { house } from "./house.ts";

/*
 * Listing copy: a house model measured by a ruler (the square footage) stands
 * beside a typewriter that turns it into words. The finished listing sheet
 * rising out of its platen slot is the lit part.
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const HOUSE = { x: -80, y: -34, w: 54, d: 40, r: 0.6 };
const TYPER = { x: 4, y: -28, w: 70, d: 54, r: 5 };
const TYPER_H = 16;
const SHEET = { x: 14, y: -22, w: 50, d: 1.6, r: 0.2 };
const SHEET_TOP = TYPER_H + 30;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-50, -14, 50],
	[40, -22, SHEET_TOP],
]);

benchPlate(s, PLATE);
house(s, HOUSE, 24, { rise: 16 });
ruler(s, { x: -82, y: 14, w: 58, d: 7, r: 1 }, 0);
// Typewriter: body, platen bar behind the sheet, keys in rows at the front.
s.halo(TYPER, 0);
s.solid(slabOf(TYPER, 0, TYPER_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(TYPER, 4), TYPER_H, s.P, 4), { tone: "faint" });
s.solid(slabOf({ x: 8, y: -26, w: 62, d: 8, r: 3 }, TYPER_H, 5, s.P, 6, 0.4), {
	tone: "lo",
});
knob(s, [12, -22], TYPER_H + 5, 3, 3);
s.solid(slabOf(SHEET, TYPER_H + 5, SHEET_TOP - TYPER_H - 5, s.P, 1), {
	lit: true,
	crease: "none",
});
faceRules(
	s,
	"y",
	SHEET.y + SHEET.d,
	SHEET.x + 5,
	SHEET_TOP - 6,
	[38, 30, 34, 22],
	5
);
s.solid(slabOf({ x: 6, y: -15, w: 66, d: 3, r: 1 }, TYPER_H, 2, s.P, 2), {
	tone: "lo",
});
// Keys: three staggered rows of round caps.
const keys: string[] = [];
for (let row = 0; row < 3; row++) {
	for (let col = 0; col < 9; col++) {
		keys.push(
			ring(14 + row * 2 + col * 6, -6 + row * 6, 1.9, TYPER_H, s.P, 12)
		);
	}
}
s.line(keys.join(""), { tone: "mid" });
s.solid(slabOf({ x: 22, y: 13, w: 34, d: 6, r: 2 }, TYPER_H, 2.4, s.P, 4), {
	tone: "lo",
});
lamp(s, [64, 17], TYPER_H, { radius: 1.6 });

export const drawing = cardDrawing(s);
