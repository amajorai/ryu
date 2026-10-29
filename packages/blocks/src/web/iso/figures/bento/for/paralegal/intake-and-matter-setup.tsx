import {
	boxCorners,
	cylinder,
	knurl,
	lineOnTop,
	planOutline,
	segment,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, faceRules } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Intake and matter setup: an expanding file. The inbound matter arrives as
 * the envelope in the letter tray; the file it becomes stands beside it with
 * tabbed dividers for parties, issues and deadlines, a date stamp ready for
 * the deadlines, and the attorney's checklist card clipped to its front (the
 * lit card), waiting to be confirmed.
 */

const PLATE = { x: -100, y: -52, w: 200, d: 104, r: 8 };
const FILE = { x: -24, y: -38, w: 72, d: 40, r: 3 };
const FILE_H = 36;
const FRONT = FILE.y + FILE.d;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[FILE.x, FILE.y, FILE_H + 14],
]);

benchPlate(s, PLATE);
// Letter tray with the inbound envelope.
const tray = { x: -90, y: -26, w: 52, d: 62, r: 3 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 7, s.P, 4, 0.6), { tone: "lo" });
const envelope = { x: -84, y: -18, w: 40, d: 46, r: 1 };
s.solid(slabOf(envelope, 4, 2.4, s.P, 2), { crease: "none" });
const flap = envelope.y + 18;
s.line(
	lineOnTop(
		[envelope.x, envelope.y],
		[envelope.x + envelope.w / 2, flap],
		6.4,
		s.P
	) +
		lineOnTop(
			[envelope.x + envelope.w, envelope.y],
			[envelope.x + envelope.w / 2, flap],
			6.4,
			s.P
		),
	{ tone: "lo" }
);
// The expanding file: body, then dividers rising out of its mouth.
s.halo(FILE, 0);
s.solid(slabOf(FILE, 0, FILE_H, s.P, 4, 0.8));
s.line(
	planOutline(
		{ x: FILE.x + 3, y: FILE.y + 3, w: FILE.w - 6, d: FILE.d - 6, r: 1 },
		FILE_H,
		s.P,
		2
	),
	{
		tone: "lo",
	}
);
const tabs = [8, 28, 48];
tabs.forEach((tx, i) => {
	const y = FILE.y + 8 + i * 11;
	s.solid(
		slabOf(
			{ x: FILE.x + 5, y, w: FILE.w - 10, d: 1.2, r: 0.3 },
			FILE_H - 4,
			10,
			s.P,
			2
		),
		{
			crease: "none",
		}
	);
	s.solid(
		slabOf({ x: FILE.x + tx, y, w: 16, d: 1.2, r: 0.4 }, FILE_H + 6, 5, s.P, 2),
		{
			tone: "lo",
			crease: "none",
		}
	);
});
// Gusset pleats down the side face.
const side = FILE.x + FILE.w;
for (let i = 1; i < 6; i++) {
	const y = FILE.y + i * (FILE.d / 6);
	s.line(segment([side, y, 4], [side, y, FILE_H - 4], s.P), { tone: "faint" });
}
// Checklist card clipped to the front.
const card = { x: FILE.x + 14, y: FRONT, w: 40, d: 1.4, r: 0.3 };
s.solid(slabOf(card, 5, 26, s.P, 2), { lit: true, crease: "none" });
for (let i = 0; i < 3; i++) {
	const zTop = 26 - i * 7;
	s.line(
		faceRect(s, "y", FRONT + 1.4, card.x + 4, card.x + 8, zTop - 4, zTop),
		{
			tone: "mid",
			free: true,
		}
	);
}
faceRules(s, "y", FRONT + 1.4, card.x + 12, 24, [22, 18], 7);
s.line(faceRect(s, "y", FRONT + 1.4, card.x + 12, card.x + 30, 9.6, 10), {
	tone: "faint",
	free: true,
});
s.solid(
	slabOf(
		{ x: card.x + 14, y: FRONT + 1.4, w: 12, d: 2, r: 0.6 },
		28,
		5,
		s.P,
		2
	),
	{
		tone: "lo",
	}
);
// Date stamp for the deadlines.
const stamp = { x: 62, y: 14, w: 22, d: 18, r: 2 };
s.halo(stamp, 0);
s.solid(slabOf(stamp, 0, 8, s.P, 3, 0.6), { tone: "lo" });
s.solid(cylinder(73, 23, 3, 8, 14, s.P, 20));
s.solid(cylinder(73, 23, 6, 22, 7, s.P, 28, 0.6));
s.line(knurl(73, 23, 6, 22, 29, 28, s.P), { tone: "lo" });

export const drawing = cardDrawing(s);
