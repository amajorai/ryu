// Unit tests for cn(): clsx conditional joining composed with tailwind-merge's
// last-wins conflict resolution.

import { describe, expect, test } from "bun:test";
import { cn } from "./utils.ts";

describe("cn", () => {
	test("joins plain class names", () => {
		expect(cn("a", "b")).toBe("a b");
	});

	test("drops falsy conditional entries", () => {
		expect(cn("a", false, null, undefined, "c")).toBe("a c");
	});

	test("later Tailwind utility wins on a conflict (tailwind-merge)", () => {
		expect(cn("p-2", "p-4")).toBe("p-4");
		expect(cn("text-sm", "text-lg")).toBe("text-lg");
	});

	test("flattens arrays and object maps", () => {
		expect(cn(["a", "b"], { c: true, d: false })).toBe("a b c");
	});

	test("no inputs yields an empty string", () => {
		expect(cn()).toBe("");
	});
});
