import { describe, expect, it } from "bun:test";
import {
	DEFAULT_HIDE_ON_FULLSCREEN,
	parseHideOnFullscreen,
} from "./hide-on-fullscreen.ts";

describe("parseHideOnFullscreen", () => {
	it("defaults to ON for null + unrecognized values", () => {
		expect(DEFAULT_HIDE_ON_FULLSCREEN).toBe(true);
		expect(parseHideOnFullscreen(null)).toBe(true);
		expect(parseHideOnFullscreen("nope")).toBe(true);
	});

	it("honours an explicit opt-out", () => {
		expect(parseHideOnFullscreen("false")).toBe(false);
		expect(parseHideOnFullscreen("0")).toBe(false);
	});

	it("honours an explicit opt-in (case + whitespace tolerant)", () => {
		expect(parseHideOnFullscreen("  True ")).toBe(true);
		expect(parseHideOnFullscreen("1")).toBe(true);
	});
});
