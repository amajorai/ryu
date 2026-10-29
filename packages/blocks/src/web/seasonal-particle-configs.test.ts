import { expect, test } from "bun:test";
import { SEASON_PARTICLES } from "./seasonal-particle-configs.ts";
import { SEASONS } from "./seasons.ts";

test("every season has a particle layer with usable ranges and colors", () => {
	for (const season of SEASONS) {
		const config = SEASON_PARTICLES[season];
		expect(config.count).toBeGreaterThan(0);
		expect(config.kinds.length).toBeGreaterThan(0);
		for (const kind of config.kinds) {
			expect(kind.weight).toBeGreaterThan(0);
			for (const [min, max] of [kind.size, kind.speed, kind.life]) {
				expect(min).toBeGreaterThan(0);
				expect(max).toBeGreaterThanOrEqual(min);
			}
			expect(kind.colors(true).length).toBeGreaterThan(0);
			expect(kind.colors(false).length).toBeGreaterThan(0);
		}
	}
});
