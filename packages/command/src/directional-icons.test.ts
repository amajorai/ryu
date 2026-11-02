import { describe, expect, test } from "bun:test";
import {
	ArrowLeftRightIcon,
	ArrowRight01Icon,
	ArrowUpRight01Icon,
	ChevronLeftIcon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import { isDirectionalIcon } from "./directional-icons.ts";

describe("isDirectionalIcon", () => {
	test("matches horizontal arrows and chevrons", () => {
		expect(isDirectionalIcon(ArrowRight01Icon)).toBe(true);
		expect(isDirectionalIcon(ChevronLeftIcon)).toBe(true);
	});

	test("leaves symmetric, diagonal and non-arrow glyphs alone", () => {
		expect(isDirectionalIcon(ArrowLeftRightIcon)).toBe(false);
		expect(isDirectionalIcon(ArrowUpRight01Icon)).toBe(false);
		expect(isDirectionalIcon(Search01Icon)).toBe(false);
	});
});
