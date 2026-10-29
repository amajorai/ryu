import { describe, expect, test } from "bun:test";
import { isDitherColor } from "./palette.ts";

describe("isDitherColor", () => {
	test("accepts only own palette keys", () => {
		expect(isDitherColor("blue")).toBe(true);
		expect(isDitherColor("__proto__")).toBe(false);
		expect(isDitherColor("constructor")).toBe(false);
		expect(isDitherColor({})).toBe(false);
	});
});
