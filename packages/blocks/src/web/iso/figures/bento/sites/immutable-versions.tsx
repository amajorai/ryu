import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	knob,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Immutable versions: a cartridge rack beside a player. Each save is a sealed
 * cartridge filed upright in the rack; the deployed build is the one seated in
 * the player (lit), and filing another cartridge never touches it.
 */

const PLATE = { x: -98, y: -54, w: 196, d: 108, r: 8 };
const RACK = { x: -86, y: -40, w: 78, d: 48, r: 3 };
const RACK_H = 6;
const PLAYER = { x: 4, y: -14, w: 80, d: 54, r: 5 };
const PLAYER_H = 24;
const CART = { w: 10, d: 36, h: 32 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [40, 13, 60]]);

function cartridge(x: number, y: number, z: number, lit = false) {
	const plan = { x, y, w: CART.w, d: CART.d, r: 1.5 };
	s.solid(slabOf(plan, z, CART.h, s.P, 4, 0.6), { lit });
	const front = y + CART.d;
	s.line(faceRect(s, "y", front, x + 2, x + CART.w - 2, z + 16, z + 26), {
		tone: lit ? "mid" : "faint",
	});
}

benchPlate(s, PLATE);
// The rack: a low tray with a slot per saved version.
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 4, 0.6), { tone: "lo" });
for (let i = 0; i < 5; i++) {
	const slot = { x: RACK.x + 6 + i * 15, y: RACK.y + 5, w: 12, d: 38, r: 1 };
	s.line(planOutline(slot, RACK_H, s.P, 2), { tone: "faint" });
}
for (let i = 0; i < 4; i++) {
	cartridge(RACK.x + 7 + i * 15, RACK.y + 6, RACK_H);
}
// The player, with the deployed cartridge seated in its top slot.
s.halo(PLAYER, 0);
s.solid(slabOf(PLAYER, 0, PLAYER_H, s.P, 8, 1.2));
s.line(planOutline(insetPlan(PLAYER, 4), PLAYER_H, s.P, 6), { tone: "faint" });
screws(
	s,
	[
		[PLAYER.x + 8, PLAYER.y + 8],
		[PLAYER.x + PLAYER.w - 8, PLAYER.y + 8],
	],
	PLAYER_H,
	1.6
);
const mouth = { x: 33, y: -7, w: 14, d: 40, r: 1.5 };
s.solid(slabOf(mouth, PLAYER_H, 1.2, s.P, 3), { tone: "lo" });
cartridge(35, -5, PLAYER_H + 1.2, true);
lamp(s, [PLAYER.x + 14, PLAYER.y + 40], PLAYER_H, { radius: 1.8 });
knob(s, [PLAYER.x + 64, PLAYER.y + 22], PLAYER_H, 4, 4);
s.solid(cylinder(PLAYER.x + 64, PLAYER.y + 40, 3, PLAYER_H, 2, s.P, 24), {
	tone: "lo",
});

export const drawing = cardDrawing(s);
