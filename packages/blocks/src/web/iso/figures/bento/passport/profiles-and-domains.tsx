import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRules, knob, lamp } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Profiles and domains: a card-file holder. Each upright card is one
 * domain's connection, tabbed at its own height; the holder is the profile,
 * and a coupling bar clamps it to the agent unit (the lit clasp binds them).
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const HOLDER = { x: -82, y: -36, w: 84, d: 62, r: 4 };
const HOLDER_H = 12;
const AGENT = { x: 44, y: -22, w: 40, d: 40, r: 4 };
const AGENT_H = 26;
const CARDS = [34, 28, 38, 30];
const TABS = [4, 18, 30, 10];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-30, 0, HOLDER_H + 46],
]);

benchPlate(s, PLATE);
// The profile: a slotted holder.
s.halo(HOLDER, 0);
s.solid(slabOf(HOLDER, 0, HOLDER_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(HOLDER, 4), HOLDER_H, s.P, 4), { tone: "faint" });
CARDS.forEach((height, i) => {
	const x = HOLDER.x + 12 + i * 18;
	const card = { x, y: HOLDER.y + 8, w: 3, d: 46, r: 0.5 };
	s.line(planOutline({ ...card, x: x - 1, w: 5 }, HOLDER_H, s.P, 2), {
		tone: "mid",
	});
	s.solid(slabOf(card, HOLDER_H, height, s.P, 2), { crease: "none" });
	const tab = { x, y: card.y + (TABS[i] ?? 0), w: 3, d: 12, r: 0.5 };
	s.solid(slabOf(tab, HOLDER_H + height, 6, s.P, 2), { tone: "lo" });
});
// Coupling bar from the holder to the agent, with its clasp.
s.solid(
	slabOf({ x: HOLDER.x + HOLDER.w, y: -6, w: 42, d: 10, r: 1 }, 4, 6, s.P, 2),
	{ tone: "lo" }
);
s.halo({ x: 16, y: -11, w: 14, d: 20, r: 2 }, 0);
s.solid(slabOf({ x: 16, y: -11, w: 14, d: 20, r: 2 }, 0, 16, s.P, 3, 0.4), {
	lit: true,
});
// The agent unit.
s.halo(AGENT, 0);
s.solid(slabOf(AGENT, 0, AGENT_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(AGENT, 4), AGENT_H, s.P, 4), { tone: "faint" });
knob(s, [AGENT.x + 16, AGENT.y + 18], AGENT_H, 7, 5);
lamp(s, [AGENT.x + AGENT.w - 10, AGENT.y + 9], AGENT_H, { radius: 1.8 });
faceRules(s, "y", AGENT.y + AGENT.d, AGENT.x + 8, 18, [22, 16, 20], 4);

export const drawing = cardDrawing(s);
