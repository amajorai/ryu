import {
	boxCorners,
	corners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../kit/iso-kit.ts";
import { benchPlate, faceRect, knob, lamp, ruler, screws } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Connections: link your accounts once, use them from any agent. A card
 * reader with one account card (the lit part) seated in its slot and the
 * others fanned in a holder beside it, a lead running to the agent's box.
 */

const WIDTH = 640;
const HEIGHT = 420;
const PLATE = { x: -140, y: -80, w: 260, d: 150, r: 8 };
const READER = { x: -110, y: -50, w: 70, d: 54, r: 6 };
const READER_H = 16;
const CARD = { w: 40, d: 2, h: 26 };
const HOLDER = { x: -24, y: -56, w: 56, d: 30, r: 3 };
const AGENT = { x: 52, y: -40, w: 56, d: 48, r: 4 };

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [READER.x, READER.y, READER_H + 30]],
	WIDTH,
	HEIGHT
);

function card(x: number, y: number, z: number, lit = false) {
	s.solid(slabOf({ x, y, w: CARD.w, d: CARD.d, r: 0.6 }, z, CARD.h, s.P, 2), {
		lit,
		tone: lit ? "hi" : "mid",
		crease: "none",
	});
	const face = y + CARD.d;
	s.line(
		faceRect(s, "y", face, x + 4, x + 12, z + CARD.h - 10, z + CARD.h - 4),
		{ tone: "mid" }
	);
	s.line(lineOnTop([x + 4, y + 1], [x + 20, y + 1], z + CARD.h, s.P), {
		tone: "faint",
	});
	s.line(
		faceRect(s, "y", face, x + 16, x + 34, z + CARD.h - 8, z + CARD.h - 6),
		{ tone: "faint" }
	);
}

function reader() {
	s.halo(READER, 0);
	s.solid(slabOf(READER, 0, READER_H, s.P, 6, 1));
	screws(s, corners(READER, 4), READER_H, 1.2);
	const slot = { x: READER.x + 15, y: READER.y + 14, w: CARD.w, d: 4, r: 1 };
	s.line(planOutline(slot, READER_H, s.P, 2), { tone: "mid" });
	lamp(s, [READER.x + 58, READER.y + 40], READER_H, { lit: true });
	knob(s, [READER.x + 14, READER.y + 40], READER_H, 3.4, 3);
	card(slot.x, slot.y + 1, READER_H - 10, true);
}

function holder() {
	s.halo(HOLDER, 0);
	s.solid(slabOf(HOLDER, 0, 8, s.P, 3, 0.6));
	s.line(planOutline(insetPlan(HOLDER, 3), 8, s.P, 2), { tone: "faint" });
	for (let i = 0; i < 3; i++) {
		card(HOLDER.x + 8 + i * 1.5, HOLDER.y + 6 + i * 8, 8 - i * 0.2);
	}
}

function agentBox() {
	s.halo(AGENT, 0);
	s.solid(slabOf(AGENT, 0, 24, s.P, 4, 1));
	s.line(planOutline(insetPlan(AGENT, 5), 24, s.P, 3), { tone: "faint" });
	lamp(s, [AGENT.x + AGENT.w - 10, AGENT.y + 10], 24);
	for (let i = 0; i < 4; i++) {
		s.line(
			lineOnTop(
				[AGENT.x + 8, AGENT.y + 22 + i * 4],
				[AGENT.x + 34, AGENT.y + 22 + i * 4],
				24,
				s.P
			)
		);
	}
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 16, w: 130, d: 7, r: 1 });
s.wire(
	[READER.x + READER.w, READER.y + 30, 6],
	[AGENT.x, AGENT.y + 30, 6],
	[
		[READER.x + READER.w + 8, READER.y + 30, 0.8],
		[AGENT.x - 8, AGENT.y + 30, 0.8],
	],
	{
		flow: true,
	}
);
reader();
holder();
agentBox();

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
