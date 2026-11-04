import { describe, expect, test } from "bun:test";
import { layerVariants } from "./nested-overflow-toolbar.tsx";

// A nested toolbar layer slides in from the inline end and out toward the
// inline start, so under dir="rtl" the physical offsets flip sign.
describe("nested overflow toolbar layer motion", () => {
	test("left-to-right layers enter from the right and leave to the left", () => {
		const variants = layerVariants(1);
		expect(variants.enter.x).toBe(12);
		expect(variants.exit.x).toBe(-12);
		expect(variants.present.x).toBe(0);
	});

	test("right-to-left layers enter from the left and leave to the right", () => {
		const variants = layerVariants(-1);
		expect(variants.enter.x).toBe(-12);
		expect(variants.exit.x).toBe(12);
		expect(variants.present).toEqual({ opacity: 1, x: 0 });
	});
});
