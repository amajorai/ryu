import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Variant generation: a bench stamping press. The master die stays on the
 * anvil; each stroke of the ram stamps a fresh card (the lit one), and the
 * finished variants pile up in the tray beside it.
 */

const PLATE = { x: -80, y: -54, w: 160, d: 104, r: 8 };
const CX = -26;
const CY = -2;
const ARM_Z = 56;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CX, -44, ARM_Z + 18],
]);

benchPlate(s, PLATE);
// Column at the back of the C-frame.
const column = { x: CX - 13, y: -46, w: 26, d: 18, r: 3 };
s.halo(column, 0);
s.solid(slabOf(column, 0, ARM_Z, s.P, 4, 0.8));
// Anvil with the die and the card being stamped.
const anvil = { x: CX - 24, y: CY - 20, w: 48, d: 40, r: 4 };
s.halo(anvil, 0);
s.solid(slabOf(anvil, 0, 12, s.P, 4, 0.8));
screws(
	s,
	[
		[anvil.x + 6, anvil.y + 6],
		[anvil.x + anvil.w - 6, anvil.y + anvil.d - 6],
	],
	12,
	1.4
);
const card = { x: CX - 14, y: CY - 14, w: 28, d: 28, r: 2 };
s.solid(slabOf(card, 12, 2, s.P, 3), { lit: true });
// Ram head and ram, held just above the card.
const head = { x: CX - 9, y: CY - 9, w: 18, d: 18, r: 2 };
s.solid(slabOf(head, 24, 5, s.P, 3, 0.4), { tone: "lo" });
s.solid(cylinder(CX, CY, 6, 29, ARM_Z - 29, s.P, 28));
// Arm reaching forward over the anvil from the column.
const arm = { x: CX - 15, y: -48, w: 30, d: 60, r: 4 };
s.solid(slabOf(arm, ARM_Z, 12, s.P, 4, 0.8));
s.line(planOutline(insetPlan(arm, 4), ARM_Z + 12, s.P, 4), { tone: "faint" });
knob(s, [CX, -36], ARM_Z + 12, 4.5, 5);
lamp(s, [CX, CY], ARM_Z + 12, { radius: 2 });
// Output tray of finished variants.
const tray = { x: 14, y: -16, w: 52, d: 50, r: 3 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 4, s.P, 4, 0.6), { tone: "lo" });
s.line(planOutline(insetPlan(tray, 3), 4, s.P, 3), { tone: "faint" });
// Each sheet lands offset from the one below, so each sheet below shows a stepped edge.
for (let index = 0; index < 4; index++) {
	const plan = { x: 32 - index * 4, y: 2 - index * 3, w: 28, d: 28, r: 2 };
	s.solid(slabOf(plan, 4 + index * 3, 3, s.P, 3));
}

export const drawing = cardDrawing(s);
