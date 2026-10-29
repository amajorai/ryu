import { expect, test } from "bun:test";
import {
	currentSeason,
	easterSunday,
	isSeason,
	isSeasonId,
} from "./seasons.ts";

test("Easter Sunday follows the Gregorian computus", () => {
	expect(easterSunday(2026)).toEqual(new Date(2026, 3, 5));
	expect(easterSunday(2027)).toEqual(new Date(2027, 2, 28));
	expect(easterSunday(2028)).toEqual(new Date(2028, 3, 16));
});

test("each season opens and closes on its own dates", () => {
	expect(isSeason("newyear", new Date(2026, 11, 31))).toBe(true);
	expect(isSeason("newyear", new Date(2027, 0, 1))).toBe(true);
	expect(isSeason("newyear", new Date(2027, 0, 2))).toBe(false);

	// Lunar New Year 2027 falls on February 6: three days of build-up, 15 days in.
	expect(isSeason("lunarnewyear", new Date(2027, 1, 2))).toBe(false);
	expect(isSeason("lunarnewyear", new Date(2027, 1, 3))).toBe(true);
	expect(isSeason("lunarnewyear", new Date(2027, 1, 20))).toBe(true);
	expect(isSeason("lunarnewyear", new Date(2027, 1, 21))).toBe(false);
	// Past the lookup table there is no Lunar New Year rather than a guess.
	expect(isSeason("lunarnewyear", new Date(2040, 1, 12))).toBe(false);

	expect(isSeason("valentines", new Date(2027, 1, 11))).toBe(false);
	expect(isSeason("valentines", new Date(2027, 1, 14))).toBe(true);

	// Good Friday through Easter Monday, 2026: April 3 to April 6.
	expect(isSeason("easter", new Date(2026, 3, 2))).toBe(false);
	expect(isSeason("easter", new Date(2026, 3, 3))).toBe(true);
	expect(isSeason("easter", new Date(2026, 3, 6))).toBe(true);
	expect(isSeason("easter", new Date(2026, 3, 7))).toBe(false);

	expect(isSeason("halloween", new Date(2026, 9, 19))).toBe(false);
	expect(isSeason("halloween", new Date(2026, 9, 27))).toBe(true);
	expect(isSeason("halloween", new Date(2026, 10, 1))).toBe(true);

	expect(isSeason("christmas", new Date(2026, 10, 30))).toBe(false);
	expect(isSeason("christmas", new Date(2026, 11, 1))).toBe(true);
	expect(isSeason("christmas", new Date(2026, 11, 30))).toBe(true);
});

test("overlapping windows resolve by priority, and quiet days have no season", () => {
	// New Year's Eve is still December, but New Year wins.
	expect(currentSeason(new Date(2026, 11, 31))).toBe("newyear");
	expect(currentSeason(new Date(2026, 11, 25))).toBe("christmas");
	// Valentine's 2026 lands inside the Lunar New Year build-up.
	expect(currentSeason(new Date(2026, 1, 14))).toBe("valentines");
	expect(currentSeason(new Date(2026, 1, 17))).toBe("lunarnewyear");
	expect(currentSeason(new Date(2026, 9, 27))).toBe("halloween");
	expect(currentSeason(new Date(2026, 6, 15))).toBeNull();
});

test("only known season ids pass the guard", () => {
	expect(isSeasonId("christmas")).toBe(true);
	expect(isSeasonId("summer")).toBe(false);
	expect(isSeasonId(null)).toBe(false);
});
