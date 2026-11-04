import { describe, expect, test } from "bun:test";
import { ratingCountLabel, surfaceListLabel } from "./listing-stat-labels.ts";

// No provider is mounted, so translate() formats the English source in "en".
describe("listing stat labels", () => {
	test("the ratings label pluralizes on the raw count", () => {
		expect(ratingCountLabel(1)).toBe("1 rating");
		expect(ratingCountLabel(1234)).toBe("1,234 ratings");
	});

	test("surfaces join as a list and keep unknown tokens", () => {
		expect(surfaceListLabel(["desktop", "web"])).toBe("Desktop and Web");
		expect(surfaceListLabel(["desktop", "web", "car"])).toBe(
			"Desktop, Web, and car"
		);
	});
});
