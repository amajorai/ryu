import { boxCorners, dotGrid, insetPlan, slabOf } from "../../kit/iso-kit.ts";
import { benchPlate, faceLine, faceRect, knob, ruler } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Marketplace: pick an agent, tool or skill and it drops into your hands. A
 * vending machine with rows of items behind its window, a keypad, and one
 * item (the lit part) waiting in the pickup tray.
 */

const WIDTH = 600;
const HEIGHT = 440;
const PLATE = { x: -110, y: -80, w: 210, d: 160, r: 8 };
const BODY = { x: -70, y: -66, w: 96, d: 56, r: 3 };
const BODY_H = 140;
const WIN = { x0: BODY.x + 8, x1: BODY.x + 66, z0: 40, z1: BODY_H - 10 };
const SHELVES = 4;

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [BODY.x, BODY.y, BODY_H + 4]],
	WIDTH,
	HEIGHT
);
const face = BODY.y + BODY.d;

function machine() {
	s.halo(BODY, 0, 7);
	s.solid(slabOf(insetPlan(BODY, -2), 0, 6, s.P, 4, 0.6), { tone: "lo" });
	s.solid(slabOf(BODY, 6, BODY_H - 6, s.P, 4, 1));
	s.solid(slabOf(insetPlan(BODY, -1.5), BODY_H, 4, s.P, 4, 0.6));
	// Window and its shelves of items.
	s.line(
		faceRect(s, "y", face, WIN.x0 - 2, WIN.x1 + 2, WIN.z0 - 2, WIN.z1 + 2),
		{ tone: "mid" }
	);
	s.line(faceRect(s, "y", face, WIN.x0, WIN.x1, WIN.z0, WIN.z1));
	const shelfH = (WIN.z1 - WIN.z0) / SHELVES;
	for (let row = 0; row < SHELVES; row++) {
		const z = WIN.z0 + row * shelfH;
		if (row > 0) {
			s.line(faceLine(s, "y", face, WIN.x0, WIN.x1, z), { tone: "mid" });
		}
		for (let col = 0; col < 4; col++) {
			const x = WIN.x0 + 4 + col * 14;
			s.line(faceRect(s, "y", face, x, x + 9, z + 3, z + shelfH - 5), {
				tone: row === 1 && col === 2 ? "faint" : "lo",
			});
		}
	}
	// Keypad column beside the window.
	const padX = WIN.x1 + 8;
	s.line(
		faceRect(s, "y", face, padX, BODY.x + BODY.w - 6, BODY_H - 34, BODY_H - 12),
		{ tone: "mid" }
	);
	s.dots(
		[0, 1, 2, 3].flatMap((r) =>
			[0, 1, 2].map((c) => s.at([padX + 4 + c * 6, face, BODY_H - 38 - r * 6]))
		),
		{ size: 0.7, tone: "mid" }
	);
	s.line(faceRect(s, "y", face, padX + 3, padX + 15, 60, 64), {
		tone: "faint",
	});
	// Pickup flap.
	s.line(faceRect(s, "y", face, WIN.x0, WIN.x1, 12, 30), { tone: "mid" });
	s.line(faceLine(s, "y", face, WIN.x0 + 4, WIN.x1 - 4, 26), { tone: "faint" });
}

function pickup() {
	const tray = { x: WIN.x0, y: face, w: WIN.x1 - WIN.x0, d: 14, r: 1.5 };
	s.solid(slabOf(tray, 10, 3, s.P, 3, 0.4));
	s.solid(
		slabOf(
			{ x: tray.x + 20, y: tray.y + 3, w: 12, d: 8, r: 1 },
			13,
			10,
			s.P,
			3,
			0.6
		),
		{ lit: true }
	);
}

benchPlate(s, PLATE);
s.dots(dotGrid(PLATE.x + 18, PLATE.y + 18, 8, 6, 24, 0, s.P), {
	size: 0.5,
	tone: "faint",
});
machine();
pickup();
knob(s, [BODY.x + BODY.w + 16, BODY.y + 20], 0, 4, 4);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 16, w: 100, d: 7, r: 1 });

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
