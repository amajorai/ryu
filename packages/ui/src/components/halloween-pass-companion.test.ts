import { expect, test } from "bun:test";
import {
	isHalloweenSeason,
	msUntilNextLocalMidnight,
} from "./halloween-season.ts";

test("the pass companion only appears from 1 October to 2 November", () => {
	expect(isHalloweenSeason(new Date(2026, 8, 30))).toBe(false);
	expect(isHalloweenSeason(new Date(2026, 9, 1))).toBe(true);
	expect(isHalloweenSeason(new Date(2026, 9, 31, 23, 59))).toBe(true);
	expect(isHalloweenSeason(new Date(2026, 10, 2))).toBe(true);
	expect(isHalloweenSeason(new Date(2026, 10, 3))).toBe(false);
});

test("the season re-check is scheduled just after the next local midnight", () => {
	const evening = new Date(2026, 9, 31, 23, 59, 30);
	const wake = new Date(evening.getTime() + msUntilNextLocalMidnight(evening));
	expect(wake.getDate()).toBe(1);
	expect(wake.getMonth()).toBe(10);
	expect(wake.getHours()).toBe(0);
	expect(wake.getMinutes()).toBe(0);
});
