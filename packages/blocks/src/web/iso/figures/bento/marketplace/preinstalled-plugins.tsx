import {
	boxCorners,
	cylinder,
	knurl,
	planOutline,
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
 * Preinstalled plugins: a cartridge backplane that ships loaded. Three
 * cartridges (browsing with a lens, crawling with a reel, security with a
 * lock dial) already sit in their slots; a fourth slot waits for more. The
 * backplane's power lamp is on (the lit part): they run from the first boot.
 */

const PLATE = { x: -92, y: -46, w: 184, d: 92, r: 8 };
const BASE = { x: -78, y: -26, w: 156, d: 50, r: 5 };
const BASE_H = 12;
const SLOT_Y = -12;
const CART = { w: 30, d: 14, h: 36 };
const SLOTS = [-68, -32, 4, 40] as const;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, SLOT_Y, BASE_H + CART.h + 8],
]);

benchPlate(s, PLATE);
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 0.8));
faceRules(s, "y", BASE.y + BASE.d, BASE.x + 10, BASE_H - 4, [40, 26], 3);
for (const [index, x] of SLOTS.entries()) {
	s.line(
		planOutline(
			{ x: x - 1.5, y: SLOT_Y - 1.5, w: CART.w + 3, d: CART.d + 3, r: 1.5 },
			BASE_H,
			s.P,
			3
		),
		{ tone: index === 3 ? "mid" : "lo" }
	);
}
// The empty fourth slot: a socket floor with a row of contact pins.
s.line(
	planOutline(
		{ x: SLOTS[3] + 3, y: SLOT_Y + 3, w: CART.w - 6, d: CART.d - 6, r: 1 },
		BASE_H,
		s.P,
		2
	),
	{ tone: "faint" }
);
for (let pin = 0; pin < 6; pin++) {
	const x = SLOTS[3] + 6 + pin * ((CART.w - 12) / 5);
	s.solid(cylinder(x, SLOT_Y + CART.d / 2, 1, BASE_H, 2.4, s.P, 12), {
		tone: "lo",
	});
}

function cartridge(x: number) {
	const plan = { x, y: SLOT_Y, w: CART.w, d: CART.d, r: 2 };
	const top = BASE_H + CART.h;
	s.solid(slabOf(plan, BASE_H, CART.h, s.P, 4, 0.8));
	faceRules(s, "y", SLOT_Y + CART.d, x + 4, top - 6, [22, 22, 22, 22], 3);
	return { cx: x + CART.w / 2, cy: SLOT_Y + CART.d / 2, top };
}

// Browsing: a lens window on top.
const browse = cartridge(SLOTS[0]);
s.solid(cylinder(browse.cx, browse.cy, 5, browse.top, 2.5, s.P, 32), {
	tone: "lo",
});
s.solid(cylinder(browse.cx, browse.cy, 3.4, browse.top + 2.5, 1, s.P, 28));
// Crawling: a cable reel standing on top.
const crawl = cartridge(SLOTS[1]);
s.solid(cylinder(crawl.cx, crawl.cy, 5.5, crawl.top, 1.4, s.P, 32));
s.solid(cylinder(crawl.cx, crawl.cy, 3.6, crawl.top + 1.4, 4, s.P, 28), {
	tone: "lo",
});
s.line(
	knurl(crawl.cx, crawl.cy, 3.6, crawl.top + 1.4, crawl.top + 5.4, 20, s.P),
	{ tone: "faint" }
);
s.solid(cylinder(crawl.cx, crawl.cy, 5.5, crawl.top + 5.4, 1.4, s.P, 32));
// Security: a knurled lock dial.
const guard = cartridge(SLOTS[2]);
s.solid(cylinder(guard.cx, guard.cy, 5, guard.top, 4, s.P, 32));
s.line(knurl(guard.cx, guard.cy, 5, guard.top, guard.top + 4, 28, s.P), {
	tone: "lo",
});
s.solid(cylinder(guard.cx, guard.cy, 2, guard.top + 4, 1.4, s.P, 16), {
	tone: "lo",
});

// Front strip: jacks, power lamp, screws.
jack(s, [-58, 14], BASE_H);
jack(s, [-46, 14], BASE_H);
lamp(s, [62, 14], BASE_H, { lit: true, radius: 3.4 });
screws(
	s,
	[
		[BASE.x + 7, BASE.y + 7],
		[BASE.x + BASE.w - 7, BASE.y + 7],
	],
	BASE_H,
	1.6
);

export const drawing = cardDrawing(s);
