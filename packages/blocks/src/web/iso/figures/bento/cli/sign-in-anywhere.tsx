import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, knob, lamp } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Sign in anywhere: a ticket printer (the terminal) has fed out a slip with a
 * short code punched in four blocks. The same four blocks stand on the tablet
 * lying beside it (the browser), and its confirm key (the lit part) is what
 * finishes the sign-in.
 */

const PLATE = { x: -98, y: -52, w: 196, d: 104, r: 8 };
const BOX = { x: -84, y: -42, w: 58, d: 40, r: 4 };
const BOX_H = 30;
const SLIP = { x: -76, y: -2, w: 42, d: 40, r: 1 };
const TABLET = { x: 2, y: -40, w: 84, d: 78, r: 6 };
const TABLET_H = 5;
const CODE = [0.9, 0.6, 1, 0.75];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[BOX.x, BOX.y, BOX_H + 6],
]);

function code(x0: number, y: number, z: number, scale: number) {
	CODE.forEach((h, i) => {
		const plan = { x: x0 + i * 8 * scale, y, w: 6 * scale, d: 7 * scale, r: 1 };
		s.solid(slabOf(plan, z, 1.2 + h * 2, s.P, 2, 0.3), { crease: "none" });
	});
}

benchPlate(s, PLATE);
// The printer: vents and a feed knob on its lid, a slot low on its face.
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BOX, 4), BOX_H, s.P, 4), { tone: "faint" });
for (let i = 0; i < 5; i++) {
	const y = BOX.y + 8 + i * 5;
	s.line(lineOnTop([BOX.x + 8, y], [BOX.x + 32, y], BOX_H, s.P));
}
knob(s, [BOX.x + 44, BOX.y + 14], BOX_H, 5, 5);
lamp(s, [BOX.x + 44, BOX.y + 30], BOX_H, { radius: 1.6 });
const face = BOX.y + BOX.d;
s.line(faceRect(s, "y", face, SLIP.x - 3, SLIP.x + SLIP.w + 3, 1, 4), {
	tone: "mid",
});
s.line(faceRect(s, "y", face, BOX.x + 6, BOX.x + 20, 18, 24), {
	tone: "faint",
});
// The slip it fed out, with the code on it.
s.halo(SLIP, 0, 3);
s.solid(slabOf(SLIP, 0, 0.8, s.P, 2), { crease: "none" });
code(SLIP.x + 6, SLIP.y + 10, 0.8, 1);
s.line(
	lineOnTop([SLIP.x + 6, SLIP.y + 26], [SLIP.x + 34, SLIP.y + 26], 0.8, s.P),
	{
		tone: "faint",
	}
);
s.line(
	lineOnTop([SLIP.x + 6, SLIP.y + 31], [SLIP.x + 24, SLIP.y + 31], 0.8, s.P),
	{
		tone: "faint",
	}
);
// The tablet: a browser bar, the same code, and the confirm key.
s.halo(TABLET, 0);
s.solid(slabOf(TABLET, 0, TABLET_H, s.P, 6, 1));
const screen = insetPlan(TABLET, 6);
s.solid(slabOf(screen, TABLET_H, 0.6, s.P, 4), { tone: "lo", crease: "none" });
const top = TABLET_H + 0.6;
s.line(
	lineOnTop(
		[screen.x, screen.y + 9],
		[screen.x + screen.w, screen.y + 9],
		top,
		s.P
	),
	{
		tone: "mid",
	}
);
s.line(
	[0, 1, 2]
		.map((i) => ring(screen.x + 5 + i * 5, screen.y + 4.5, 1.4, top, s.P, 12))
		.join(""),
	{ tone: "mid" }
);
s.solid(
	slabOf(
		{ x: screen.x + 22, y: screen.y + 2.5, w: 40, d: 4, r: 1.5 },
		top,
		0.6,
		s.P,
		2
	),
	{
		crease: "none",
	}
);
code(screen.x + 13, screen.y + 20, top, 1.4);
s.solid(
	slabOf(
		{ x: screen.x + 20, y: screen.y + 46, w: 32, d: 10, r: 2 },
		top,
		2.4,
		s.P,
		3,
		0.4
	),
	{
		lit: true,
	}
);

export const drawing = cardDrawing(s);
