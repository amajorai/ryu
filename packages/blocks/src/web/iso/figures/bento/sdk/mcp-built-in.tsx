import {
	boxCorners,
	cylinder,
	lineOnTop,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * MCP built in: a tool chest with both halves of the connector fixed to the
 * same bench. The server is the socket bolted to the chest; the client is a
 * plug carriage on a slide rail, its pins (the lit part) already lined up
 * with the socket, so the pair ships together.
 */

const PLATE = { x: -96, y: -48, w: 178, d: 84, r: 8 };
const CHEST = { x: -84, y: -34, w: 54, d: 52, r: 4 };
const CHEST_H = 36;
const SOCKET = { x: -30, y: -16, w: 22, d: 30, r: 3 };
const RAIL = { x: -8, y: -12, w: 80, d: 24, r: 3 };
const CARRIAGE = { x: 22, y: -16, w: 36, d: 30, r: 4 };
const PIN_Z = 11;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CHEST.x, CHEST.y, CHEST_H + 6],
]);

benchPlate(s, PLATE);
// Tool chest: three drawers on its front face, handles as short bars.
s.halo(CHEST, 0);
s.solid(slabOf(CHEST, 0, CHEST_H, s.P, 6, 0.8));
const front = CHEST.y + CHEST.d;
for (let i = 0; i < 3; i++) {
	const z0 = 4 + i * 10.5;
	s.line(
		faceRect(s, "y", front, CHEST.x + 5, CHEST.x + CHEST.w - 5, z0, z0 + 8.5),
		{
			tone: "lo",
		}
	);
	s.solid(
		slabOf(
			{ x: CHEST.x + CHEST.w / 2 - 7, y: front, w: 14, d: 2.4, r: 0.8 },
			z0 + 3.4,
			1.8,
			s.P,
			2
		),
		{ tone: "lo", crease: "none" }
	);
}
lamp(s, [CHEST.x + CHEST.w - 10, CHEST.y + 10], CHEST_H, { radius: 1.8 });
// Server socket bolted to the chest's side.
s.halo(SOCKET, 0);
s.solid(slabOf(SOCKET, 0, 26, s.P, 4, 0.8));
s.line(
	faceRect(s, "x", SOCKET.x + SOCKET.w, SOCKET.y + 6, SOCKET.y + 24, 8, 18),
	{
		tone: "mid",
	}
);
screws(
	s,
	[
		[SOCKET.x + 11, SOCKET.y + 5],
		[SOCKET.x + 11, SOCKET.y + SOCKET.d - 5],
	],
	26,
	1.3
);
// Slide rail with the client carriage riding it.
s.solid(slabOf(RAIL, 0, 4, s.P, 4, 0.6), { tone: "lo" });
s.line(lineOnTop([RAIL.x + 4, 0], [RAIL.x + RAIL.w - 4, 0], 4, s.P), {
	tone: "faint",
});
for (const dy of [-6, 6]) {
	s.solid(
		slabOf(
			{
				x: SOCKET.x + SOCKET.w,
				y: dy - 3,
				w: CARRIAGE.x - SOCKET.x - SOCKET.w,
				d: 6,
				r: 1,
			},
			PIN_Z,
			6,
			s.P,
			2
		),
		{ lit: true, crease: "none" }
	);
}
s.halo(CARRIAGE, 4);
s.solid(slabOf(CARRIAGE, 4, 20, s.P, 5, 0.8));
s.solid(cylinder(CARRIAGE.x + 20, 0, 5, 24, 5, s.P, 24), { tone: "lo" });
s.solid(cylinder(CARRIAGE.x + 20, 0, 2.6, 29, 3, s.P, 20));
s.solid(slabOf({ x: 63, y: -4, w: 8, d: 8, r: 2 }, 4, 6, s.P, 3), {
	tone: "lo",
});

export const drawing = cardDrawing(s);
