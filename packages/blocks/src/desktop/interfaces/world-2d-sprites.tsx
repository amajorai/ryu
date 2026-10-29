/**
 * Character identity shared by the 2D and 3D worlds. The 2D village's pixel
 * art lives in `world-2d-characters.ts`, `world-2d-flora.ts`,
 * `world-2d-buildings.ts` and `world-2d-ground.ts`; its colors in
 * `world-2d-palette.ts`.
 */
import { HAIR_COLORS, SKIN_TONES } from "./world-2d-palette.ts";

export { TILE } from "./world-2d-pixel.ts";

/** Stable look for an agent: skin tone, hair color, and hair style. */
export function characterLook(agentId: string): {
	hair: string;
	hairStyle: number;
	skin: (typeof SKIN_TONES)[number];
} {
	let hash = 7;
	for (const char of agentId) {
		hash = (hash * 33 + (char.codePointAt(0) ?? 0)) % 100_003;
	}
	return {
		hair: HAIR_COLORS[hash % HAIR_COLORS.length] ?? HAIR_COLORS[0],
		hairStyle: Math.floor(hash / 7) % 4,
		skin: SKIN_TONES[Math.floor(hash / 3) % SKIN_TONES.length] ?? SKIN_TONES[0],
	};
}
