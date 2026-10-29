import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	radialTicks,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, byDepth, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Rotate secrets: a seal-stamp carousel beside a mailbox. Turning the wheel
 * brings a fresh signing seal to the front (the lit stamp) while the mailbox
 * behind it stays exactly where it was.
 */

const PLATE = { x: -90, y: -52, w: 164, d: 104, r: 8 };
const MAILBOX = { x: -80, y: -44, w: 40, d: 36, r: 4 };
const MAILBOX_H = 36;
const HUB: [number, number] = [22, 2];
const WHEEL_R = 44;
const WHEEL_Z = 18;
const STAMPS = 5;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[HUB[0], HUB[1], WHEEL_Z + 30],
	[MAILBOX.x + MAILBOX.w, MAILBOX.y, MAILBOX_H + 18],
	[MAILBOX.x, MAILBOX.y, MAILBOX_H],
]);

benchPlate(s, PLATE);
// The mailbox: a tall box with a letter slot and a raised flag.
s.halo(MAILBOX, 0);
s.solid(slabOf(MAILBOX, 0, MAILBOX_H, s.P, 6, 1));
s.line(planOutline(insetPlan(MAILBOX, 5), MAILBOX_H, s.P, 4), {
	tone: "faint",
});
s.line(
	planOutline(
		{ x: MAILBOX.x + 8, y: MAILBOX.y + 16, w: 24, d: 4, r: 1 },
		MAILBOX_H,
		s.P,
		2
	),
	{ tone: "mid" }
);
s.solid(
	slabOf(
		{ x: MAILBOX.x + MAILBOX.w, y: MAILBOX.y + 6, w: 3, d: 3, r: 0.5 },
		18,
		34,
		s.P,
		2
	)
);
s.solid(
	slabOf(
		{ x: MAILBOX.x + MAILBOX.w, y: MAILBOX.y + 6, w: 3, d: 14, r: 0.5 },
		44,
		8,
		s.P,
		2
	),
	{ tone: "lo" }
);
lamp(s, [MAILBOX.x + 8, MAILBOX.y + 29], MAILBOX_H, { radius: 1.6 });
// Carousel column and its base.
s.halo({ x: HUB[0] - 18, y: HUB[1] - 18, w: 36, d: 36, r: 18 }, 0);
s.solid(cylinder(HUB[0], HUB[1], 18, 0, 4, s.P, 32, 0.6), { tone: "lo" });
s.solid(cylinder(HUB[0], HUB[1], 8, 4, WHEEL_Z - 4, s.P, 24));
// The wheel, with stamp handles standing on its rim.
s.solid(cylinder(HUB[0], HUB[1], WHEEL_R, WHEEL_Z, 5, s.P, 64, 0.8));
const grip = radialTicks(
	HUB[0],
	HUB[1],
	WHEEL_R - 1,
	48,
	6,
	WHEEL_Z + 5,
	[2.5, 4],
	s.P
);
s.line(grip.minor, { tone: "faint" });
s.line(grip.major, { tone: "lo" });
s.line(ring(HUB[0], HUB[1], WHEEL_R - 6, WHEEL_Z + 5, s.P, 64), {
	tone: "faint",
});
s.solid(cylinder(HUB[0], HUB[1], 7, WHEEL_Z + 5, 4, s.P, 24), { tone: "lo" });
s.line(knurl(HUB[0], HUB[1], 7, WHEEL_Z + 5, WHEEL_Z + 9, 20, s.P), {
	tone: "lo",
});
screws(s, [[HUB[0], HUB[1]]], WHEEL_Z + 9, 2);
const stamps = Array.from({ length: STAMPS }, (_, i) => {
	const angle = Math.PI / 4 + (i / STAMPS) * Math.PI * 2;
	return [
		HUB[0] + Math.cos(angle) * (WHEEL_R - 14),
		HUB[1] + Math.sin(angle) * (WHEEL_R - 14),
		i === 0,
	] as const;
});
for (const [x, y, active] of byDepth([...stamps], s, WHEEL_Z)) {
	s.solid(cylinder(x, y, 7, WHEEL_Z + 5, 3, s.P, 24), { tone: "lo" });
	s.solid(cylinder(x, y, 2.4, WHEEL_Z + 8, 12, s.P, 14));
	s.solid(cylinder(x, y, 5.5, WHEEL_Z + 20, 6, s.P, 28, 0.8), { lit: active });
}

export const drawing = cardDrawing(s);
