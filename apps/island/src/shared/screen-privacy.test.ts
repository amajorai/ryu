import { describe, expect, it } from "bun:test";
import {
	DEFAULT_SCREEN_PRIVACY,
	parseScreenPrivacy,
} from "./screen-privacy.ts";

describe("parseScreenPrivacy", () => {
	it("defaults to ON (excluded from capture) for null + unknown values", () => {
		expect(DEFAULT_SCREEN_PRIVACY).toBe(true);
		expect(parseScreenPrivacy(null)).toBe(true);
		expect(parseScreenPrivacy("maybe")).toBe(true);
	});

	it("honours an explicit opt-out", () => {
		expect(parseScreenPrivacy("false")).toBe(false);
		expect(parseScreenPrivacy(" 0 ")).toBe(false);
	});

	it("honours an explicit opt-in", () => {
		expect(parseScreenPrivacy("TRUE")).toBe(true);
		expect(parseScreenPrivacy("1")).toBe(true);
	});
});
