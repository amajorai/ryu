import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Same agents: the Ryu server keeps its agents as three pucks seated on top.
 * The phone stands in a cable-fed cradle in front and shows the same three
 * on its screen; the agent you are chatting with (the lit puck) is the
 * server's own, not a copy.
 */

const PLATE = { x: -96, y: -52, w: 192, d: 104, r: 8 };
const SERVER = { x: -84, y: -42, w: 82, d: 52, r: 5 };
const SERVER_H = 28;
const STAND = { x: 30, y: 6, w: 54, d: 30, r: 4 };
const STAND_H = 6;
const PHONE = { x: 36, y: 16, w: 42, d: 6, r: 2 };
const PHONE_TOP = STAND_H + 54;
const PUCKS = [-64, -43, -22];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[PHONE.x, PHONE.y, PHONE_TOP + 2],
]);

benchPlate(s, PLATE);
// The server, with its agents seated in sockets on top.
s.halo(SERVER, 0);
s.solid(slabOf(SERVER, 0, SERVER_H, s.P, 6, 1));
s.line(planOutline(insetPlan(SERVER, 4), SERVER_H, s.P, 4), { tone: "faint" });
lamp(s, [SERVER.x + SERVER.w - 9, SERVER.y + 8], SERVER_H, { radius: 1.6 });
screws(s, [[SERVER.x + 9, SERVER.y + SERVER.d - 8]], SERVER_H, 1.4);
for (const [i, x] of PUCKS.entries()) {
	const y = SERVER.y + 22;
	s.line(ring(x, y, 9, SERVER_H, s.P, 32), { tone: "lo" });
	s.solid(cylinder(x, y, 7.5, SERVER_H, 8, s.P, 32, 0.6), { lit: i === 1 });
	s.line(ring(x, y, 3, SERVER_H + 8, s.P, 20), { tone: "mid" });
}
// Cable from the server's front face, along the bench, into the cradle.
s.wire(
	[SERVER.x + 64, SERVER.y + SERVER.d, 8],
	[STAND.x, STAND.y + 24, 3],
	[[SERVER.x + 64, STAND.y + 24, 0.8]]
);
// The cradle: a base, a back rest and a front lip holding the phone upright.
s.halo(STAND, 0);
s.solid(slabOf(STAND, 0, STAND_H, s.P, 4, 0.8), { tone: "lo" });
s.solid(
	slabOf(
		{ x: PHONE.x + 8, y: PHONE.y - 6, w: 26, d: 6, r: 1 },
		STAND_H,
		24,
		s.P,
		3
	)
);
s.solid(slabOf(PHONE, STAND_H, PHONE_TOP - STAND_H, s.P, 4, 0.6), {
	tone: "hi",
	crease: "lo",
});
// The screen on its front face, listing the same three agents.
const face = PHONE.y + PHONE.d;
const left = PHONE.x + 4;
const right = PHONE.x + PHONE.w - 4;
s.line(faceRect(s, "y", face, left, right, STAND_H + 10, PHONE_TOP - 6), {
	tone: "mid",
});
for (let i = 0; i < 3; i++) {
	const top = PHONE_TOP - 12 - i * 13;
	s.line(faceRect(s, "y", face, left + 4, left + 12, top - 8, top), {
		tone: i === 1 ? "mid" : "lo",
	});
	s.line(
		faceRect(s, "y", face, left + 15, right - 4 - i * 4, top - 5, top - 2),
		{
			tone: "faint",
		}
	);
}
s.solid(
	slabOf(
		{ x: PHONE.x - 2, y: face, w: PHONE.w + 4, d: 4, r: 1 },
		STAND_H,
		6,
		s.P,
		3
	),
	{ tone: "mid" }
);
s.line(
	lineOnTop(
		[STAND.x + 6, STAND.y + STAND.d - 4],
		[STAND.x + 20, STAND.y + STAND.d - 4],
		STAND_H,
		s.P
	),
	{ tone: "faint" }
);

export const drawing = cardDrawing(s);
