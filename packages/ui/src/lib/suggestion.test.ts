// Unit test for the inline-suggestion variant helper (class-variance-authority).
// Pins the insert=green / remove=red styling contract the editor relies on when
// rendering accepted/rejected inline suggestion spans.

import { describe, expect, test } from "bun:test";
import { inlineSuggestionVariants } from "./suggestion.ts";

describe("inlineSuggestionVariants", () => {
	test("emits the insert (emerald) and remove (red) state classes", () => {
		const cls = inlineSuggestionVariants();
		expect(cls).toBeString();
		expect(cls).toContain(
			"data-[inline-suggestion=insert]:bg-suggestion-insert-surface!"
		);
		expect(cls).toContain(
			"data-[inline-suggestion=remove]:bg-suggestion-remove-surface!"
		);
		expect(cls).toContain(
			"data-[inline-suggestion=insert]:text-suggestion-insert-foreground!"
		);
		expect(cls).toContain(
			"data-[inline-suggestion=remove]:text-suggestion-remove-foreground!"
		);
	});
});
