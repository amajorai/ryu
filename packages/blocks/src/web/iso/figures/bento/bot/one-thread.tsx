import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, knob, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";
import { arc, ribbon, tangent } from "./ribbon.ts";

/*
 * One thread: a reel-to-reel deck. The conversation is one unbroken tape,
 * wound from the full reel past the head (the lit part) onto the take-up
 * reel, so every earlier turn is still on the spool.
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const DECK = { x: -90, y: -46, w: 180, d: 84, r: 5 };
const DECK_H = 8;
const REEL_Y = -14;
const REEL_R = 26;
const ROLLER_R = 3.2;
const HEAD = { x: -9, y: 18 + ROLLER_R + 0.6, w: 18, d: 9, r: 2 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, 30]]);

function reel(x: number, pack: number) {
	s.solid(cylinder(x, REEL_Y, 4, DECK_H, 2, s.P, 20), { tone: "lo" });
	s.solid(cylinder(x, REEL_Y, REEL_R, DECK_H + 2, 1.4, s.P, 56, 0.3));
	s.solid(cylinder(x, REEL_Y, pack, DECK_H + 3.4, 4, s.P, 48), {
		tone: "lo",
	});
	s.line(ring(x, REEL_Y, pack - 3, DECK_H + 7.4, s.P, 40), { tone: "faint" });
	s.solid(cylinder(x, REEL_Y, 6, DECK_H + 7.4, 3, s.P, 24, 0.4));
	s.line(ring(x, REEL_Y, 2, DECK_H + 10.4, s.P, 12), { tone: "mid" });
}

function roller(x: number, y: number) {
	s.solid(cylinder(x, y, ROLLER_R, DECK_H, 9, s.P, 20, 0.3));
}

benchPlate(s, PLATE);
s.halo(DECK, 0);
s.solid(slabOf(DECK, 0, DECK_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(DECK, 4), DECK_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[DECK.x + 8, DECK.y + 8],
		[DECK.x + DECK.w - 8, DECK.y + 8],
	],
	DECK_H,
	1.3
);
reel(-48, 20);
reel(48, 12);
// The tape: one strip, as tall as the packs, leaving the full reel, round the
// guide rollers and across the head's face, onto the take-up reel.
const PACK_Z = DECK_H + 3.4;
const left: [number, number, number] = [-48, REEL_Y, 20];
const right: [number, number, number] = [48, REEL_Y, 12];
const guideL: [number, number, number] = [-26, 18, ROLLER_R];
const guideR: [number, number, number] = [26, 18, ROLLER_R];
const [leaveL, onGuideL] = tangent(left, guideL, 1);
const [offGuideL, onGuideR] = tangent(guideL, guideR, 1);
const [offGuideR, joinR] = tangent(guideR, right, 1);
const angle = ([cx, cy]: [number, number, number], [x, y]: [number, number]) =>
	Math.atan2(y - cy, x - cx);
roller(guideL[0], guideL[1]);
roller(guideR[0], guideR[1]);
ribbon(
	s,
	[
		leaveL,
		...arc(guideL, angle(guideL, onGuideL), angle(guideL, offGuideL), 4),
		...arc(guideR, angle(guideR, onGuideR), angle(guideR, offGuideR), 4),
		joinR,
	],
	PACK_Z,
	4,
	1.2,
	{ tone: "hi" }
);
// The playback head the tape runs against.
s.halo(HEAD, DECK_H);
s.solid(slabOf(HEAD, DECK_H, 10, s.P, 3, 0.6), { lit: true });
// Transport keys and the volume knob along the front edge.
for (const x of [-80, -70, -60]) {
	s.solid(slabOf({ x, y: 24, w: 8, d: 8, r: 1.2 }, DECK_H, 2.4, s.P, 2), {
		tone: "lo",
	});
}
knob(s, [72, 28], DECK_H, 5, 5);

export const drawing = cardDrawing(s);
