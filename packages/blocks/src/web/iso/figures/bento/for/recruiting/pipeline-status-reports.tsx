import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, knob, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Pipeline status reports: a card file, one compartment per hiring stage, the
 * stacks thinning stage by stage like a funnel. The printer at the end has
 * read the counts and is feeding out the status slip (the lit part).
 */

const PLATE = { x: -102, y: -48, w: 204, d: 96, r: 8 };
const TRAY = { x: -90, y: -30, w: 122, d: 56, r: 3 };
const TRAY_H = 4;
const STAGE_W = 24;
const COUNTS = [6, 5, 3, 2, 1];
const PRINTER = { x: 44, y: -28, w: 46, d: 46, r: 4 };
const PRINTER_H = 20;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[66, -4, PRINTER_H + 22],
]);

function divider(x: number) {
	s.solid(
		slabOf(
			{ x, y: TRAY.y + 2, w: 2, d: TRAY.d - 4, r: 0.4 },
			TRAY_H,
			12,
			s.P,
			2
		),
		{ tone: "lo" }
	);
}

benchPlate(s, PLATE);
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 4, 0.6));
COUNTS.forEach((count, stage) => {
	const x0 = TRAY.x + 1 + stage * STAGE_W;
	divider(x0);
	for (let k = 0; k < count; k++) {
		s.solid(
			slabOf(
				{ x: x0 + 4 + k * 3, y: TRAY.y + 6, w: 1.4, d: TRAY.d - 12, r: 0.3 },
				TRAY_H,
				18,
				s.P,
				2
			),
			{ crease: "none" }
		);
	}
});
divider(TRAY.x + 1 + COUNTS.length * STAGE_W);
// The report printer, slip rising from its slot.
s.halo(PRINTER, 0);
s.solid(slabOf(PRINTER, 0, PRINTER_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(PRINTER, 4), PRINTER_H, s.P, 4), {
	tone: "faint",
});
const slot = { x: 52, y: -12, w: 30, d: 4, r: 1 };
s.line(planOutline(slot, PRINTER_H, s.P, 2), { tone: "mid" });
lamp(s, [PRINTER.x + 8, PRINTER.y + 8], PRINTER_H, { radius: 1.8 });
const slip = { x: 54, y: -11, w: 26, d: 1.4, r: 0.2 };
s.solid(slabOf(slip, PRINTER_H, 20, s.P, 2), { lit: true, crease: "none" });
faceRules(s, "y", slip.y + slip.d, slip.x + 4, PRINTER_H + 16, [16, 12, 14], 4);
knob(
	s,
	[PRINTER.x + PRINTER.w - 10, PRINTER.y + PRINTER.d - 10],
	PRINTER_H,
	4,
	4
);

export const drawing = cardDrawing(s);
