import { describe, expect, test } from "bun:test";
import { parseAutoResumeInterruptedThreads } from "./auto-resume-preference.ts";

describe("parseAutoResumeInterruptedThreads", () => {
	test("defaults on when unset or unrecognized", () => {
		expect(parseAutoResumeInterruptedThreads(null)).toBe(true);
		expect(parseAutoResumeInterruptedThreads("true")).toBe(true);
		expect(parseAutoResumeInterruptedThreads("maybe")).toBe(true);
	});

	test("only explicit off values disable it", () => {
		for (const value of ["false", " FALSE ", "0", "off", "no"]) {
			expect(parseAutoResumeInterruptedThreads(value)).toBe(false);
		}
	});
});
