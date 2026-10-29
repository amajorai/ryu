import {
	boxCorners,
	cylinder,
	depthOf,
	knurl,
	lineOnTop,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * One source, many languages: a rotary distributor. The one source page (the
 * lit sheet) stands in the hub; four chutes run out to four trays, one per
 * language, and each tray carries its own glossary cartridge at the back.
 */

const PLATE = { x: -106, y: -64, w: 212, d: 128, r: 8 };
const HUB_R = 15;
const HUB_H = 30;
const CHUTE_H = 4;
const TRAY_H = 5;
const OUTLETS: [number, number][] = [
	[0, -44],
	[-76, 0],
	[76, 0],
	[0, 44],
];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, HUB_H + 20]]);

function chute([cx, cy]: [number, number]) {
	const plan =
		cx === 0
			? { x: -4, y: Math.min(cy, 0) + (cy < 0 ? 14 : 0), w: 8, d: 30, r: 1.5 }
			: { x: Math.min(cx, 0) + (cx < 0 ? 18 : 0), y: -4, w: 40, d: 8, r: 1.5 };
	s.solid(slabOf(plan, 0, CHUTE_H, s.P, 2, 0.4), { tone: "lo" });
	const along: [[number, number], [number, number]] =
		cx === 0
			? [
					[0, plan.y + 2],
					[0, plan.y + plan.d - 2],
				]
			: [
					[plan.x + 2, 0],
					[plan.x + plan.w - 2, 0],
				];
	s.line(lineOnTop(along[0], along[1], CHUTE_H, s.P), { tone: "faint" });
}

function tray([cx, cy]: [number, number]) {
	const plan = { x: cx - 16, y: cy - 14, w: 32, d: 28, r: 3 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, TRAY_H, s.P, 3, 0.6));
	const page = { x: cx - 13, y: cy - 4, w: 26, d: 15, r: 1 };
	s.solid(slabOf(page, TRAY_H, 1.2, s.P, 2), { tone: "lo", crease: "none" });
	for (let i = 0; i < 2; i++) {
		const y = page.y + 4 + i * 5;
		s.line(
			lineOnTop([page.x + 3, y], [page.x + 18 - i * 5, y], TRAY_H + 1.2, s.P),
			{ tone: "mid" }
		);
	}
	// The language's own glossary cartridge, along the back edge.
	const cartridge = { x: cx - 13, y: cy - 12, w: 26, d: 6, r: 1 };
	s.solid(slabOf(cartridge, TRAY_H, 9, s.P, 2, 0.4));
	lamp(s, [cx + 8, cy - 9], TRAY_H + 9, { radius: 1.3 });
}

function hub() {
	s.halo({ x: -22, y: -22, w: 44, d: 44, r: 22 }, 0);
	s.solid(cylinder(0, 0, 21, 0, 6, s.P, 48, 0.6));
	s.solid(cylinder(0, 0, HUB_R, 6, HUB_H - 6, s.P, 48));
	s.line(knurl(0, 0, HUB_R, 8, 14, 40, s.P), { tone: "lo" });
	s.line(ring(0, 0, HUB_R - 4, HUB_H, s.P, 40), { tone: "mid" });
	s.solid(slabOf({ x: -1, y: -9, w: 2, d: 18, r: 0.3 }, HUB_H, 18, s.P, 2), {
		lit: true,
		crease: "none",
	});
}

benchPlate(s, PLATE);
const hubDepth = depthOf([0, 0, 0], s.P);
const sorted = [...OUTLETS].sort(
	(a, b) => depthOf([a[0], a[1], 0], s.P) - depthOf([b[0], b[1], 0], s.P)
);
const far = sorted.filter(([x, y]) => depthOf([x, y, 0], s.P) < hubDepth);
const near = sorted.filter(([x, y]) => depthOf([x, y, 0], s.P) >= hubDepth);
for (const outlet of far) {
	tray(outlet);
	chute(outlet);
}
hub();
for (const outlet of near) {
	chute(outlet);
	tray(outlet);
}
screws(
	s,
	[
		[-80, -48],
		[80, 48],
	],
	0,
	1.4
);

export const drawing = cardDrawing(s);
