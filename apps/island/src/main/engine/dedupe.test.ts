import { describe, expect, it } from "bun:test";
import { hashKey, SuggestionDedupe, suggestionKey } from "./dedupe.ts";

describe("hashKey", () => {
	it("is stable for the same input", () => {
		expect(hashKey("hello")).toBe(hashKey("hello"));
	});

	it("differs for different input", () => {
		expect(hashKey("hello")).not.toBe(hashKey("world"));
	});
});

describe("suggestionKey", () => {
	it("is case-insensitive and combines title + app", () => {
		expect(suggestionKey("Summarize", "Code")).toBe(
			suggestionKey("summarize", "code")
		);
	});

	it("differs across apps for the same title", () => {
		expect(suggestionKey("Summarize", "Code")).not.toBe(
			suggestionKey("Summarize", "Slack")
		);
	});
});

describe("SuggestionDedupe", () => {
	it("suppresses a key within the TTL window", () => {
		const dedupe = new SuggestionDedupe(1000, 10);
		dedupe.record("k", 0);
		expect(dedupe.isDuplicate("k", 500)).toBe(true);
		expect(dedupe.isDuplicate("k", 1500)).toBe(false);
	});

	it("treats unseen keys as non-duplicate", () => {
		const dedupe = new SuggestionDedupe(1000, 10);
		expect(dedupe.isDuplicate("never", 0)).toBe(false);
	});

	it("evicts the oldest entry past the cap", () => {
		const dedupe = new SuggestionDedupe(10_000, 2);
		dedupe.record("a", 0);
		dedupe.record("b", 1);
		dedupe.record("c", 2);
		// "a" should have been evicted, so it is no longer a known duplicate.
		expect(dedupe.isDuplicate("a", 3)).toBe(false);
		expect(dedupe.isDuplicate("b", 3)).toBe(true);
		expect(dedupe.isDuplicate("c", 3)).toBe(true);
	});

	it("clears all state", () => {
		const dedupe = new SuggestionDedupe(1000, 10);
		dedupe.record("k", 0);
		dedupe.clear();
		expect(dedupe.isDuplicate("k", 100)).toBe(false);
	});
});
