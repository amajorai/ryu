import { describe, expect, test } from "bun:test";
import { parseScore } from "./AnnotationQueuesPanel-parsing.ts";

describe("annotation score parsing by locale", () => {
	test("accepts a comma decimal under de", () => {
		expect(parseScore("3,5", "de")).toBe(3.5);
		expect(parseScore("0,7", "de")).toBeCloseTo(0.7);
	});

	test("keeps English input unchanged", () => {
		expect(parseScore("4.5", "en")).toBe(4.5);
		expect(parseScore("-2", "en")).toBe(-2);
	});

	test("blank stays undefined and unreadable stays null", () => {
		expect(parseScore(" ", "de")).toBeUndefined();
		expect(parseScore("four", "de")).toBeNull();
	});
});
