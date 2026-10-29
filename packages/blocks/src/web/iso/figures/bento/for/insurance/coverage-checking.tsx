import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";
import { openBox } from "./open-box.ts";

/*
 * Coverage checking: a card-index cabinet holding the policy wording, one
 * clause per card. The claim folder lies open beside it; the drawer is pulled
 * and the one clause that applies stands raised out of the deck (the lit
 * card), ready to be quoted.
 */

const PLATE = { x: -100, y: -56, w: 200, d: 112, r: 8 };
const CAB = { x: -10, y: -46, w: 74, d: 54, r: 3 };
const CAB_H = 34;
const CAB_FRONT = CAB.y + CAB.d;
const DRAWER = { x: -2, y: CAB_FRONT, w: 58, d: 40, r: 1 };
const DRAWER_Z = 4;
const DRAWER_H = 14;
const CARDS = 8;
const RAISED = 5;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [24, 0, 44]]);

benchPlate(s, PLATE);
// The claim folder: two open leaves with a few rule lines.
const folder = { x: -88, y: -30, w: 66, d: 58, r: 2 };
s.halo(folder, 0);
s.solid(slabOf(folder, 0, 2, s.P, 3, 0.4), { tone: "lo" });
for (const leaf of [folder.x + 3, folder.x + folder.w / 2 + 1]) {
	const sheet = {
		x: leaf,
		y: folder.y + 3,
		w: folder.w / 2 - 4,
		d: folder.d - 6,
		r: 1,
	};
	s.solid(slabOf(sheet, 2, 1, s.P, 2), { crease: "none" });
	for (let i = 0; i < 5; i++) {
		const y = sheet.y + 8 + i * 9;
		s.line(
			lineOnTop(
				[sheet.x + 4, y],
				[sheet.x + sheet.w - 6 - (i % 2) * 6, y],
				3,
				s.P
			),
			{
				tone: i === 0 ? "mid" : "lo",
			}
		);
	}
}
// Cabinet with the upper drawer closed and the lower one pulled out.
s.halo(CAB, 0);
s.solid(slabOf(CAB, 0, CAB_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(CAB, 4), CAB_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[CAB.x + 8, CAB.y + 8],
		[CAB.x + CAB.w - 8, CAB.y + 8],
	],
	CAB_H,
	1.4
);
const front = CAB.y + CAB.d;
s.line(faceRect(s, "y", front, CAB.x + 6, CAB.x + CAB.w - 6, 21, 31), {
	tone: "lo",
});
s.solid(slabOf({ x: 20, y: front, w: 14, d: 2, r: 0.5 }, 24, 2.5, s.P, 2), {
	tone: "lo",
});
// The empty slot the drawer came out of.
s.line(
	faceRect(
		s,
		"y",
		front,
		DRAWER.x - 1,
		DRAWER.x + DRAWER.w + 1,
		DRAWER_Z - 1,
		DRAWER_Z + DRAWER_H + 1
	),
	{ tone: "lo" }
);
openBox(s, DRAWER, DRAWER_Z, DRAWER_H, () => {
	for (let i = 0; i < CARDS; i++) {
		const raised = i === RAISED;
		s.solid(
			slabOf(
				{
					x: DRAWER.x + 5,
					y: DRAWER.y + 5 + i * 4,
					w: DRAWER.w - 10,
					d: 1.4,
					r: 0.3,
				},
				DRAWER_Z + 2,
				raised ? DRAWER_H + 14 : DRAWER_H - 1,
				s.P,
				2
			),
			{ lit: raised, crease: "none" }
		);
	}
});
s.solid(
	slabOf(
		{ x: 20, y: DRAWER.y + DRAWER.d, w: 14, d: 2.5, r: 0.5 },
		10,
		3,
		s.P,
		2
	),
	{ tone: "lo" }
);

export const drawing = cardDrawing(s);
