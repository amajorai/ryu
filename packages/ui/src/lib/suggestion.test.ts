// Unit test for the inline-suggestion variant helper (class-variance-authority).
// Pins the insert=green / remove=red styling contract the editor relies on when
// rendering accepted/rejected inline suggestion spans.

import { describe, expect, test } from "bun:test";
import { inlineSuggestionVariants } from "./suggestion.ts";

describe("inlineSuggestionVariants", () => {
	test("emits the insert (emerald) and remove (red) state classes", () => {
		const cls = inlineSuggestionVariants();
		expect(typeof cls).toBe("string");
		expect(cls).toContain("data-[inline-suggestion=insert]:bg-emerald-100!");
		expect(cls).toContain("data-[inline-suggestion=remove]:bg-red-100!");
		expect(cls).toContain("data-[inline-suggestion=insert]:text-emerald-700!");
		expect(cls).toContain("data-[inline-suggestion=remove]:text-red-700!");
	});
});
