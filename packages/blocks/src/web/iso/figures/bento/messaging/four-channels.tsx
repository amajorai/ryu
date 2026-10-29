import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Four channels: a manifold with four outlet pipes, one per channel, each
 * capped for what it carries: a plain cap (SMS), a wide flange (MMS), an open
 * pipe sending a capsule out (WhatsApp, the lit part) and a speaker horn
 * (voice).
 */

const PLATE = { x: -96, y: -36, w: 192, d: 72, r: 8 };
const BASE = { x: -84, y: -20, w: 168, d: 40, r: 5 };
const BASE_H = 12;
const PIPE_R = 10;
const XS = [-56, -18, 20, 58];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-18, 0, 62]]);

function pipe(x: number, height: number) {
	s.solid(cylinder(x, 0, PIPE_R + 2.5, BASE_H, 2, s.P, 32), { tone: "lo" });
	s.solid(cylinder(x, 0, PIPE_R, BASE_H + 2, height, s.P, 32));
	s.line(ring(x, 0, PIPE_R, BASE_H + 2 + height * 0.5, s.P, 32), {
		tone: "faint",
	});
	return BASE_H + 2 + height;
}

benchPlate(s, PLATE);
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BASE, 4), BASE_H, s.P, 4), { tone: "faint" });
knob(s, [BASE.x + 10, 0], BASE_H, 5, 6);
// Lamps along the front edge, sitting under the pipe tops.
for (const x of XS) {
	lamp(s, [x, BASE.y + BASE.d - 4], BASE_H, { radius: 1.4 });
}
// SMS: a plain cap.
const sms = pipe(XS[0] ?? 0, 24);
s.solid(cylinder(XS[0] ?? 0, 0, PIPE_R + 1.5, sms, 4, s.P, 32, 0.6));
// MMS: a wide flange with bolts.
const mms = pipe(XS[1] ?? 0, 30);
s.solid(cylinder(XS[1] ?? 0, 0, PIPE_R + 6, mms, 3, s.P, 36, 0.6));
screws(
	s,
	[
		[(XS[1] ?? 0) - 10, 0],
		[(XS[1] ?? 0) + 10, 0],
	],
	mms + 3,
	1.2
);
// WhatsApp: open pipe, a capsule leaving it.
const chat = pipe(XS[2] ?? 0, 20);
s.line(ring(XS[2] ?? 0, 0, PIPE_R - 2, chat, s.P, 32), { tone: "lo" });
s.solid(cylinder(XS[2] ?? 0, 0, PIPE_R - 3, chat - 4, 16, s.P, 28, 0.8), {
	lit: true,
});
// Voice: a stepped speaker horn with a grille.
const voice = pipe(XS[3] ?? 0, 14);
s.solid(cylinder(XS[3] ?? 0, 0, PIPE_R + 3, voice, 3, s.P, 36));
s.solid(cylinder(XS[3] ?? 0, 0, PIPE_R + 7, voice + 3, 3, s.P, 40));
s.solid(cylinder(XS[3] ?? 0, 0, PIPE_R + 11, voice + 6, 3, s.P, 44, 0.6));
for (const radius of [4, 8, 12, 16]) {
	s.line(ring(XS[3] ?? 0, 0, radius, voice + 9, s.P, 36), { tone: "lo" });
}

export const drawing = cardDrawing(s);
