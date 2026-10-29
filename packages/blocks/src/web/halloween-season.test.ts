import { expect, test } from "bun:test";
import { isHalloweenSeason } from "./halloween-season.ts";

test("Halloween season runs October 20 through November 1", () => {
	expect(isHalloweenSeason(new Date(2026, 9, 19))).toBe(false);
	expect(isHalloweenSeason(new Date(2026, 9, 20))).toBe(true);
	expect(isHalloweenSeason(new Date(2026, 9, 31, 23, 59))).toBe(true);
	expect(isHalloweenSeason(new Date(2026, 10, 1))).toBe(true);
	expect(isHalloweenSeason(new Date(2026, 10, 2))).toBe(false);
	expect(isHalloweenSeason(new Date(2027, 3, 25))).toBe(false);
});
