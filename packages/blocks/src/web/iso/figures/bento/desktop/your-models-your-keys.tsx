import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, jack, knob, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Your models, your keys: a source console with three bays. A model cartridge
 * stands in the first bay, your own key lies in the second, the third takes a
 * plan card. The lit lamp marks the source in use; the knob picks another.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const BODY = { x: -82, y: -38, w: 164, d: 66, r: 5 };
const H = 18;
const BAY_Y = -32;
const BAY_D = 30;
const BAYS = [-74, -34, 6] as const;
const BAY_W = 32;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-58, BAY_Y, H + 34],
]);

benchPlate(s, PLATE);
s.halo(BODY, 0);
s.solid(slabOf(BODY, 0, H, s.P, 8, 1.2));
s.line(planOutline(insetPlan(BODY, 4), H, s.P, 6), { tone: "faint" });
screws(
	s,
	[
		[BODY.x + BODY.w - 8, BODY.y + 8],
		[BODY.x + 8, BODY.y + BODY.d - 8],
	],
	H,
	1.6
);
// Three recessed bays across the back of the top.
for (const x of BAYS) {
	const bay = { x, y: BAY_Y, w: BAY_W, d: BAY_D, r: 2 };
	s.solid(slabOf(bay, H, 0.4, s.P, 3), { tone: "lo", crease: "none" });
	s.line(planOutline(bay, H + 0.4, s.P, 3), { tone: "mid" });
}
// Bay one: a ribbed model cartridge standing in its socket.
const cart = { x: BAYS[0] + 6, y: BAY_Y + 9, w: BAY_W - 12, d: 12, r: 1.5 };
s.solid(slabOf(cart, H, 30, s.P, 3, 0.6));
for (const z of [H + 22, H + 18, H + 14]) {
	s.line(
		planOutline(
			{ x: cart.x + 3, y: cart.y + cart.d, w: cart.w - 6, d: 0, r: 0 },
			z,
			s.P,
			1
		),
		{ tone: "lo" }
	);
}
// Bay two: your own key lying in its bay, round bow and toothed blade.
const keyY = BAY_Y + BAY_D / 2;
const bowX = BAYS[1] + 9;
const blade = { x: bowX + 4, y: keyY - 2, w: 17, d: 4, r: 0.8 };
s.solid(slabOf(blade, H + 0.4, 2, s.P, 2));
for (const x of [blade.x + 9, blade.x + 13]) {
	s.solid(slabOf({ x, y: keyY + 2, w: 2.4, d: 3, r: 0.4 }, H + 0.4, 2, s.P, 1));
}
s.solid(cylinder(bowX, keyY, 7, H + 0.4, 2.4, s.P, 36, 0.4));
s.line(ring(bowX, keyY, 2.6, H + 2.8, s.P, 24), { tone: "lo" });
// Bay three: a flat plan card resting in its slot.
const card = {
	x: BAYS[2] + 5,
	y: BAY_Y + 6,
	w: BAY_W - 10,
	d: BAY_D - 12,
	r: 1.5,
};
s.solid(slabOf(card, H + 0.4, 2, s.P, 3), { tone: "mid" });
s.line(planOutline(insetPlan(card, 4), H + 2.4, s.P, 2), { tone: "faint" });
// Front row: one lamp per bay, the selector knob and a cable jack.
const LAMP_Y = BAY_Y + BAY_D + 10;
BAYS.forEach((x, index) => {
	lamp(s, [x + BAY_W / 2, LAMP_Y], H, { lit: index === 0, radius: 2.4 });
});
knob(s, [60, LAMP_Y - 18], H, 8, 6);
jack(s, [62, LAMP_Y + 4], H);

export const drawing = cardDrawing(s);
