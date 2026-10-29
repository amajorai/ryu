import { describe, expect, test } from "bun:test";
import {
	buildCottages,
	COTTAGE_WINDOWS,
	type CottageSpec,
	doorWood,
	litWindows,
} from "./game3d-cottages.tsx";
import { agentSwatches, GAME3D_DAY } from "./game3d-palette.ts";

const swatch = agentSwatches(["ada"]).get("ada");
if (!swatch) {
	throw new Error("no swatch");
}
const cottage = (extra: Partial<CottageSpec>): CottageSpec => ({
	chimneySide: 1,
	door: doorWood(1),
	lit: false,
	origin: [0, 0, 0],
	porch: false,
	seed: 1,
	swatch,
	...extra,
});
const glow = (spec: CottageSpec) => {
	const parts = buildCottages([spec], GAME3D_DAY);
	return { dark: parts.glass.length, lit: parts.litGlass.length };
};

describe("cottage pips", () => {
	test("without pips, lit lights every window", () => {
		expect(glow(cottage({ lit: true }))).toEqual({
			dark: 0,
			lit: COTTAGE_WINDOWS,
		});
		expect(glow(cottage({ lit: false }))).toEqual({
			dark: COTTAGE_WINDOWS,
			lit: 0,
		});
	});

	test("pips light one window per share of the done steps", () => {
		expect(litWindows({ lit: true, pips: { done: 0, total: 4 } })).toBe(0);
		expect(litWindows({ lit: true, pips: { done: 2, total: 4 } })).toBe(3);
		expect(litWindows({ lit: false, pips: { done: 5, total: 5 } })).toBe(5);
		expect(litWindows({ lit: false, pips: { done: 9, total: 5 } })).toBe(5);
		expect(litWindows({ lit: true, pips: { done: 1, total: 0 } })).toBe(0);
		expect(glow(cottage({ lit: true, pips: { done: 3, total: 5 } }))).toEqual({
			dark: 2,
			lit: 3,
		});
	});
});
