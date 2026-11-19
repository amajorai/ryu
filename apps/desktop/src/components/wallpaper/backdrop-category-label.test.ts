import { describe, expect, test } from "bun:test";
import { BACKDROP_CATEGORIES } from "@ryu/ui/components/backdrop/definitions.ts";
import { backdropCategoryLabel } from "./backdrop-category-label.ts";

const tl = (source: string) => `[${source}]`;

describe("backdropCategoryLabel", () => {
	test("every registry category is a translated message", () => {
		for (const category of BACKDROP_CATEGORIES) {
			expect(backdropCategoryLabel(category, tl)).toMatch(/^\[.+\]$/u);
		}
	});

	test("Decorative and Shader library are translated, Light and Space say what they hold", () => {
		expect(backdropCategoryLabel("Decorative", tl)).toBe("[Decorative]");
		expect(backdropCategoryLabel("Shader library", tl)).toBe(
			"[Shader library]"
		);
		expect(backdropCategoryLabel("Light", tl)).toBe("[Light effects]");
		expect(backdropCategoryLabel("Space", tl)).toBe("[Outer space]");
	});

	test("a plugin's own category is returned as written", () => {
		expect(backdropCategoryLabel("Neon", tl)).toBe("Neon");
	});
});
