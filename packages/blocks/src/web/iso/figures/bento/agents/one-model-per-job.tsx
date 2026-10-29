import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	ring,
	sideRing,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRules, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * One model per job: a deck with three bays, each holding a different
 * cartridge: a ruled chat block, a grilled voice capsule and an image block
 * with a lens. One agent, three models, each swappable on its own; the lit
 * cap marks the cartridge that is answering.
 */

const PLATE = { x: -96, y: -46, w: 192, d: 84, r: 8 };
const DECK = { x: -82, y: -32, w: 164, d: 56, r: 5 };
const DECK_H = 14;
const BAY_Y = -8;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-50, BAY_Y, DECK_H + 42],
]);

benchPlate(s, PLATE);
s.halo(DECK, 0);
s.solid(slabOf(DECK, 0, DECK_H, s.P, 6, 1));
s.line(planOutline(insetPlan(DECK, 4), DECK_H, s.P, 4), { tone: "faint" });
screws(
	s,
	[
		[DECK.x + 8, DECK.y + 8],
		[DECK.x + DECK.w - 8, DECK.y + DECK.d - 8],
	],
	DECK_H,
	1.6
);
// Bay sockets cut into the deck top.
for (const x of [-50, 0, 50]) {
	s.line(
		planOutline(
			{ x: x - 18, y: BAY_Y - 12, w: 36, d: 24, r: 3 },
			DECK_H,
			s.P,
			3
		),
		{ tone: "lo" }
	);
}
// Chat cartridge: a tall ruled block.
const chat = { x: -64, y: BAY_Y - 8, w: 28, d: 16, r: 2 };
s.solid(slabOf(chat, DECK_H, 38, s.P, 3, 0.8));
s.solid(slabOf(insetPlan(chat, 3), DECK_H + 38, 3, s.P, 3), { tone: "lo" });
faceRules(
	s,
	"y",
	chat.y + chat.d,
	chat.x + 5,
	DECK_H + 30,
	[18, 14, 16, 10],
	5
);
// Voice cartridge: a capsule with a ringed grille.
s.solid(cylinder(0, BAY_Y, 13, DECK_H, 4, s.P, 36), { tone: "lo" });
s.solid(cylinder(0, BAY_Y, 11, DECK_H + 4, 28, s.P, 36, 0.8));
s.line(knurl(0, BAY_Y, 11, DECK_H + 17, DECK_H + 32, 30, s.P), {
	tone: "lo",
});
s.line(ring(0, BAY_Y, 11, DECK_H + 17, s.P, 36), { tone: "lo" });
// The live model: a lit cap on the voice capsule.
s.solid(cylinder(0, BAY_Y, 6, DECK_H + 32, 2, s.P, 28, 0.4), { lit: true });
// Image cartridge: a squat block with a lens on its front face.
const image = { x: 36, y: BAY_Y - 9, w: 28, d: 18, r: 2 };
const lensY = image.y + image.d;
s.solid(slabOf(image, DECK_H, 24, s.P, 3, 0.8));
s.line(sideRing([50, lensY, DECK_H + 12], 8, "y", s.P, 28), { tone: "mid" });
s.line(sideRing([50, lensY, DECK_H + 12], 5, "y", s.P, 24), { tone: "lo" });
s.line(sideRing([50, lensY, DECK_H + 12], 2, "y", s.P, 16), { tone: "lo" });
s.solid(cylinder(58, BAY_Y - 4, 2.4, DECK_H + 24, 3, s.P, 16), { tone: "lo" });
// One lamp per bay along the front edge.
for (const x of [-50, 0, 50]) {
	lamp(s, [x, DECK.y + DECK.d - 7], DECK_H, { radius: 2 });
}

export const drawing = cardDrawing(s);
