import { describe, expect, test } from "bun:test";
import { isDeprecated, resolveDeprecation } from "./deprecation.ts";

describe("marketplace deprecation", () => {
	test("presence is the signal, including an empty notice", () => {
		expect(isDeprecated(undefined)).toBe(false);
		expect(isDeprecated(null)).toBe(false);
		expect(isDeprecated({})).toBe(true);
		expect(isDeprecated({ message: "Use New." })).toBe(true);
	});

	test("prefers the detail notice over the card and trims blanks", () => {
		expect(resolveDeprecation(null, null)).toBeNull();
		expect(resolveDeprecation(undefined, { message: "  " })).toEqual({
			message: null,
			replacement: null,
		});
		expect(
			resolveDeprecation(
				{ message: "From detail.", replacement: "@acme/new" },
				{ message: "From card." }
			)
		).toEqual({ message: "From detail.", replacement: "@acme/new" });
		expect(resolveDeprecation(null, { replacement: "@acme/new" })).toEqual({
			message: null,
			replacement: "@acme/new",
		});
	});
});
