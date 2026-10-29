import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Receipt and invoice chasing: a row of client mailboxes on posts. A box
 * whose receipts have come in has its flag down; the one client who still
 * owes documents has its flag raised (lit). The drafted follow-up letters
 * wait in the outgoing tray in front.
 */

const PLATE = { x: -88, y: -48, w: 150, d: 86, r: 8 };
const BOX_W = 28;
const BOX_D = 38;
const BOX_Z = 18;
const BOX_H = 22;
const BOXES = [
	{ x: -78, owes: false },
	{ x: -30, owes: true },
	{ x: 18, owes: false },
];
const ROW_Y = -40;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-16, ROW_Y + 10, BOX_Z + BOX_H + 14],
]);

/** One client's mailbox on its post, flag up when documents are owed. */
function mailbox(x: number, owes: boolean) {
	const cx = x + BOX_W / 2;
	const cy = ROW_Y + BOX_D / 2;
	s.halo({ x: cx - 9, y: cy - 9, w: 18, d: 18, r: 3 }, 0);
	s.solid(slabOf({ x: cx - 8, y: cy - 8, w: 16, d: 16, r: 2 }, 0, 3, s.P, 3), {
		tone: "lo",
	});
	s.solid(
		slabOf({ x: cx - 3, y: cy - 3, w: 6, d: 6, r: 1 }, 3, BOX_Z - 3, s.P, 2)
	);
	const plan = { x, y: ROW_Y, w: BOX_W, d: BOX_D, r: 3 };
	s.solid(slabOf(plan, BOX_Z, BOX_H, s.P, 6, 0.8));
	s.line(planOutline(insetPlan(plan, 3), BOX_Z + BOX_H, s.P, 4), {
		tone: "faint",
	});
	const front = ROW_Y + BOX_D;
	s.line(
		faceRect(s, "y", front, x + 4, x + BOX_W - 4, BOX_Z + 3, BOX_Z + BOX_H - 3),
		{
			tone: "lo",
		}
	);
	s.solid(
		slabOf({ x: cx - 3, y: front, w: 6, d: 1.6, r: 0.4 }, BOX_Z + 8, 2, s.P, 2),
		{
			tone: "lo",
		}
	);
	// The flag on the right side: raised and lit, or folded down.
	const side = x + BOX_W;
	s.solid(cylinder(side + 1, ROW_Y + 10, 1.6, BOX_Z + 6, 2, s.P, 12), {
		tone: "lo",
	});
	if (owes) {
		s.solid(
			slabOf(
				{ x: side, y: ROW_Y + 8.5, w: 2, d: 3, r: 0.4 },
				BOX_Z + 6,
				22,
				s.P,
				2
			),
			{ lit: true }
		);
		s.solid(
			slabOf(
				{ x: side, y: ROW_Y + 8.5, w: 2, d: 10, r: 0.6 },
				BOX_Z + 20,
				8,
				s.P,
				2
			),
			{ lit: true }
		);
	} else {
		s.solid(
			slabOf(
				{ x: side, y: ROW_Y + 8.5, w: 2, d: 16, r: 0.6 },
				BOX_Z + 4,
				4,
				s.P,
				2
			)
		);
	}
}

benchPlate(s, PLATE);
for (const { x, owes } of BOXES) {
	mailbox(x, owes);
}
// Outgoing tray with the drafted follow-ups, stacked.
const TRAY = { x: -40, y: 4, w: 54, d: 28, r: 4 };
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 6, s.P, 4, 0.6));
s.line(planOutline(insetPlan(TRAY, 4), 6, s.P, 3), { tone: "lo" });
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf({ x: -30 + i, y: 9 - i, w: 34, d: 18, r: 1 }, 6 + i * 2, 2, s.P, 2),
		{ tone: i === 2 ? "mid" : "lo", crease: "none" }
	);
}

export const drawing = cardDrawing(s);
