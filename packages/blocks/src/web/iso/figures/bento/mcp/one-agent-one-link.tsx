import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRules,
	jack,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * One agent, one link: an agent cabinet with a single socket block in front
 * of it. One cable runs from a client handset at the left straight into that
 * socket; its plug (the lit part) is the whole connection, nothing in between.
 */

const PLATE = { x: -96, y: -52, w: 192, d: 104, r: 8 };
const CAB = { x: 18, y: -42, w: 58, d: 46, r: 4 };
const CAB_H = 40;
const SOCKET = { x: 28, y: 14, w: 26, d: 22, r: 3 };
const SOCKET_H = 10;
const PLUG: [number, number] = [41, 25];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CAB.x, CAB.y, CAB_H + 8],
	[PLUG[0], PLUG[1], SOCKET_H + 24],
]);

benchPlate(s, PLATE);
// The agent cabinet at the back right: vents on its face, a dial on top.
s.halo(CAB, 0);
s.solid(slabOf(CAB, 0, CAB_H, s.P, 6, 1));
s.line(planOutline(insetPlan(CAB, 5), CAB_H, s.P, 4), { tone: "faint" });
faceRules(s, "y", CAB.y + CAB.d, CAB.x + 8, 32, [34, 26, 30, 22], 5);
s.solid(cylinder(CAB.x + 20, CAB.y + 20, 9, CAB_H, 2, s.P, 32), { tone: "lo" });
s.solid(cylinder(CAB.x + 20, CAB.y + 20, 7, CAB_H + 2, 5, s.P, 32));
s.line(knurl(CAB.x + 20, CAB.y + 20, 7, CAB_H + 2, CAB_H + 7, 28, s.P), {
	tone: "lo",
});
lamp(s, [CAB.x + CAB.w - 10, CAB.y + 10], CAB_H, { radius: 1.8 });
screws(
	s,
	[
		[CAB.x + CAB.w - 8, CAB.y + CAB.d - 8],
		[CAB.x + 8, CAB.y + CAB.d - 8],
	],
	CAB_H,
	1.3
);
// Client handset at the front left, lying on its back.
const phone = { x: -80, y: -22, w: 30, d: 44, r: 5 };
s.halo(phone, 0);
s.solid(slabOf(phone, 0, 6, s.P, 6, 0.6));
s.line(planOutline(insetPlan(phone, 4), 6, s.P, 4), { tone: "lo" });
s.line(ring(phone.x + phone.w / 2, phone.y + phone.d - 3, 1.2, 6, s.P, 12), {
	tone: "mid",
});
// Socket block, cabinet-wired from underneath.
s.halo(SOCKET, 0);
s.solid(slabOf(SOCKET, 0, SOCKET_H, s.P, 4, 0.8), { tone: "lo" });
screws(
	s,
	[
		[SOCKET.x + 4, SOCKET.y + 4],
		[SOCKET.x + SOCKET.w - 4, SOCKET.y + SOCKET.d - 4],
	],
	SOCKET_H,
	1.1
);
jack(s, [SOCKET.x + SOCKET.w - 5, SOCKET.y + 5], SOCKET_H);
// The plug, seated: collar, grip, and the cable boot.
s.solid(cylinder(PLUG[0], PLUG[1], 7, SOCKET_H, 2, s.P, 28), { tone: "lo" });
s.solid(cylinder(PLUG[0], PLUG[1], 6, SOCKET_H + 2, 9, s.P, 28, 0.4), {
	lit: true,
});
s.solid(cylinder(PLUG[0], PLUG[1], 2.6, SOCKET_H + 11, 3, s.P, 20));
// The single cable, from the handset's side to the plug's boot.
s.wire(
	[phone.x + phone.w, phone.y + 30, 3],
	[PLUG[0], PLUG[1], SOCKET_H + 14],
	[
		[-20, 30, 1],
		[14, 32, 1],
		[26, 30, SOCKET_H + 8],
		[36, 26, SOCKET_H + 15],
	]
);

export const drawing = cardDrawing(s);
