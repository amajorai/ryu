import { describe, expect, it } from "bun:test";
import {
	DEFAULT_WEB_SEARCH_ACCESS_MODE,
	isWebSearchAccessMode,
	parseWebSearchAccessMode,
	WEB_SEARCH_ACCESS_MODE_OPTIONS,
} from "./web-search-access.ts";

describe("web search access modes", () => {
	it("exposes the four supported settings in the screenshot order", () => {
		expect(
			WEB_SEARCH_ACCESS_MODE_OPTIONS.map((option) => option.value)
		).toEqual(["disabled", "cached", "indexed", "live"]);
	});

	it("defaults only missing preferences to the compatible mode", () => {
		expect(DEFAULT_WEB_SEARCH_ACCESS_MODE).toBe("live");
		expect(parseWebSearchAccessMode(null)).toBe("live");
		expect(() => parseWebSearchAccessMode("future-mode")).toThrow(
			"Invalid web search access mode preference"
		);
	});

	it("accepts only known preference values", () => {
		for (const value of ["disabled", "cached", "indexed", "live"]) {
			expect(isWebSearchAccessMode(value)).toBe(true);
		}
		expect(isWebSearchAccessMode(undefined)).toBe(false);
		expect(isWebSearchAccessMode({ mode: "live" })).toBe(false);
	});
});
