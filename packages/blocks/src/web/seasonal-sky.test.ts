import { expect, test } from "bun:test";
import { heroSkyFor } from "./seasonal-sky.ts";
import { SEASONS } from "./seasons.ts";

const HEX = /^#[0-9a-f]{6}$/;

function luma(hex: string): number {
	const n = Number.parseInt(hex.slice(1), 16);
	// biome-ignore lint/suspicious/noBitwiseOperators: unpacking an RGB hex.
	return (
		0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
	);
}

test("light is a morning sky and dark is a night sky, with or without a season", () => {
	for (const season of [null, ...SEASONS]) {
		const day = heroSkyFor(season, "light");
		const night = heroSkyFor(season, "dark");
		expect(day.night).toBe(false);
		expect(night.night).toBe(true);
		for (const color of [...day.colors, ...night.colors]) {
			expect(color).toMatch(HEX);
		}
		// Night's open sky is darker than morning's at the zenith and horizon.
		expect(luma(night.colors[0])).toBeLessThan(luma(day.colors[0]));
		expect(luma(night.colors[1])).toBeLessThan(luma(day.colors[1]));
	}
});

test("every season tints both skies with its own colors", () => {
	for (const theme of ["light", "dark"] as const) {
		const plain = heroSkyFor(null, theme).colors;
		const skies = SEASONS.map((season) => heroSkyFor(season, theme).colors);
		for (const sky of skies) {
			expect(sky).not.toEqual(plain);
		}
		expect(new Set(skies.map((sky) => sky.join())).size).toBe(SEASONS.length);
	}
});
