import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, faceRules, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Stored messages: an open archive tray of upright envelopes, kept in order
 * behind index dividers, with a parcel crate beside it for attachments.
 * One envelope is lifted for reading (the lit part); nothing leaves the tray.
 */

const PLATE = { x: -100, y: -48, w: 200, d: 96, r: 8 };
const TRAY = { x: -86, y: -30, w: 116, d: 52, r: 4 };
const TRAY_H = 20;
const CRATE = { x: 46, y: -14, w: 38, d: 36, r: 3 };
const CRATE_H = 22;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners(TRAY, 0, TRAY_H + 24),
]);

benchPlate(s, PLATE);
// The tray: thick walls, open top.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, TRAY_H, s.P, 6, 1));
s.solid(slabOf(insetPlan(TRAY, 4), TRAY_H - 0.1, 0.1, s.P, 4), {
	tone: "lo",
	crease: "none",
});
s.line(planOutline(insetPlan(TRAY, 4), TRAY_H, s.P, 4), { tone: "lo" });
// Envelopes standing on edge, with a taller divider every few.
const inner = insetPlan(TRAY, 6);
for (let i = 0; i < 11; i++) {
	const x = inner.x + 4 + i * 9.5;
	const divider = i === 0 || i === 5;
	const lifted = i === 8;
	const rise = divider ? 14 : 9;
	s.solid(
		slabOf(
			{ x, y: inner.y + 2, w: divider ? 2 : 3, d: inner.d - 4, r: 0.4 },
			lifted ? TRAY_H + 2 : TRAY_H,
			lifted ? 20 : rise,
			s.P,
			2
		),
		{
			lit: lifted,
			tone: divider ? "lo" : "mid",
			crease: "none",
		}
	);
	if (divider) {
		// The divider's index tab.
		s.solid(
			slabOf(
				{ x, y: inner.y + 6, w: 2, d: 12, r: 0.4 },
				TRAY_H + rise,
				4,
				s.P,
				2
			),
			{ tone: "lo", crease: "none" }
		);
	}
}
// Label frame and pull on the tray's front.
const front = TRAY.y + TRAY.d;
s.line(faceRect(s, "y", front, -40, -4, 6, 14), { tone: "lo" });
faceRules(s, "y", front, -36, 11, [22, 14], 3);
screws(
	s,
	[
		[TRAY.x + 8, front - 1],
		[TRAY.x + TRAY.w - 8, front - 1],
	],
	TRAY_H,
	1.2
);
// The attachment crate: a lidded box tied with a band.
s.halo(CRATE, 0);
s.solid(slabOf(CRATE, 0, CRATE_H, s.P, 4, 0.8));
s.solid(slabOf(insetPlan(CRATE, -1.5), CRATE_H, 4, s.P, 4, 0.6), {
	tone: "lo",
});
s.solid(
	slabOf(
		{
			x: CRATE.x + CRATE.w / 2 - 2,
			y: CRATE.y - 2,
			w: 4,
			d: CRATE.d + 4,
			r: 0.5,
		},
		CRATE_H + 4,
		1,
		s.P,
		2
	),
	{ crease: "none" }
);
s.line(
	faceRect(
		s,
		"y",
		CRATE.y + CRATE.d,
		CRATE.x + CRATE.w / 2 - 2,
		CRATE.x + CRATE.w / 2 + 2,
		0,
		CRATE_H
	),
	{ tone: "mid" }
);

export const drawing = cardDrawing(s);
