import { describe, expect, it } from "bun:test";
import { DEFAULT_AUTO_JUMP, parseAutoJump } from "./auto-jump.ts";

describe("parseAutoJump", () => {
	it("defaults to off for null and unrecognized values", () => {
		expect(DEFAULT_AUTO_JUMP).toBe(false);
		expect(parseAutoJump(null)).toBe(false);
		expect(parseAutoJump("yes")).toBe(false);
		expect(parseAutoJump("")).toBe(false);
	});

	it("reads true/1 (case + whitespace tolerant)", () => {
		expect(parseAutoJump("true")).toBe(true);
		expect(parseAutoJump("  TRUE ")).toBe(true);
		expect(parseAutoJump("1")).toBe(true);
	});

	it("reads false/0", () => {
		expect(parseAutoJump("false")).toBe(false);
		expect(parseAutoJump("0")).toBe(false);
	});
});
