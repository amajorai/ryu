import { boxCorners, slabOf } from "../../kit/iso-kit.ts";
import { benchPlate, faceRect, faceRules, ruler } from "./parts.ts";
import { createSketch } from "./sketch.tsx";
import type { StaticDrawing } from "./static-figure.tsx";

/*
 * Ryu for Chrome: a page-aware companion in the browser. A browser window
 * standing on the bench, tabs and address bar along its top, and the
 * extension (the lit part) docking into the toolbar from above.
 */

const WIDTH = 620;
const HEIGHT = 440;
const PLATE = { x: -120, y: -84, w: 230, d: 160, r: 8 };
const WIN = { x: -96, y: -54, w: 180, d: 8, r: 3 };
const WIN_H = 110;
const DOCK_X = 52;
const LIFT = 22;

const s = createSketch(
	[...boxCorners(PLATE, -15, 0), [WIN.x, WIN.y, WIN_H + LIFT + 20]],
	WIDTH,
	HEIGHT
);
const face = WIN.y + WIN.d;

function windowFrame() {
	const stand = { x: -40, y: -64, w: 60, d: 30, r: 4 };
	s.halo(stand, 0);
	s.solid(slabOf(stand, 0, 6, s.P, 4, 0.6));
	s.solid(slabOf(WIN, 6, WIN_H, s.P, 3, 1));
	const top = 6 + WIN_H;
	// Tabs, then the toolbar with the address bar.
	for (let i = 0; i < 3; i++) {
		const x = WIN.x + 8 + i * 34;
		s.line(faceRect(s, "y", face, x, x + 30, top - 10, top - 3), {
			tone: i === 0 ? "mid" : "lo",
		});
	}
	s.dots(
		[0, 1, 2].map((k) => s.at([WIN.x + WIN.w - 22 + k * 5, face, top - 6.5])),
		{ size: 0.8, tone: "mid" }
	);
	s.line(
		faceRect(s, "y", face, WIN.x + 4, WIN.x + WIN.w - 4, top - 22, top - 12),
		{ tone: "mid" }
	);
	s.line(faceRect(s, "y", face, WIN.x + 24, WIN.x + 130, top - 20, top - 14));
	// The toolbar socket the extension seats into.
	s.line(faceRect(s, "y", face, DOCK_X - 7, DOCK_X + 7, top - 21, top - 13), {
		tone: "mid",
	});
	// The page: a heading, an image block and text.
	s.line(faceRect(s, "y", face, WIN.x + 4, WIN.x + WIN.w - 4, 10, top - 24));
	s.line(faceRect(s, "y", face, WIN.x + 14, WIN.x + 80, 40, top - 38), {
		tone: "lo",
	});
	faceRules(s, "y", face, WIN.x + 90, top - 34, [70, 60, 74, 50, 66, 40], 8);
	faceRules(s, "y", face, WIN.x + 14, 32, [120, 96], 8);
}

function extension() {
	const top = 6 + WIN_H;
	const z = top - 21 + LIFT;
	const y = face + 2;
	s.solid(
		slabOf({ x: DOCK_X - 7, y: y - 4, w: 14, d: 4, r: 1.2 }, z, 8, s.P, 3, 0.4),
		{ lit: true }
	);
	// The puzzle tab on its back that keys into the socket.
	s.solid(
		slabOf({ x: DOCK_X - 2.5, y: y - 6, w: 5, d: 2, r: 1 }, z + 2, 4, s.P, 3),
		{ lit: true, crease: "none" }
	);
	s.line(faceRect(s, "y", y, DOCK_X - 4, DOCK_X + 4, z + 2, z + 6), {
		tone: "mid",
	});
}

benchPlate(s, PLATE);
ruler(s, { x: PLATE.x + 14, y: PLATE.y + PLATE.d - 14, w: 110, d: 7, r: 1 });
windowFrame();
extension();

export const drawing: StaticDrawing = {
	width: WIDTH,
	height: HEIGHT,
	nodes: s.nodes(),
};
