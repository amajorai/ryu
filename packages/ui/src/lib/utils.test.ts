// Unit tests for the shared cn() Tailwind class-merging contract.

import { describe, expect, test } from "bun:test";
import { cn } from "./utils.ts";

describe("cn", () => {
	test("joins plain class names", () => {
		expect(cn("flex", "underline")).toBe("flex underline");
	});

	test("drops falsy conditional entries", () => {
		expect(cn("flex", false, null, undefined, "italic")).toBe("flex italic");
	});

	test("later Tailwind utility wins on a conflict", () => {
		expect(cn("p-2", "p-4")).toBe("p-4");
		expect(cn("text-sm", "text-lg")).toBe("text-lg");
	});

	test("flattens arrays and object maps", () => {
		expect(cn(["flex", "underline"], { italic: true, border: false })).toBe(
			"flex underline italic"
		);
	});

	test("no inputs yields an empty string", () => {
		expect(cn()).toBe("");
	});
});
