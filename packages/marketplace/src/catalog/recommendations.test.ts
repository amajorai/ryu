import { describe, expect, test } from "bun:test";
import { normalizeRecommendations } from "./recommendations.ts";

describe("normalizeRecommendations", () => {
	test("keeps safe cross-kind card fields and drops unknown rows", () => {
		const result = normalizeRecommendations({
			cadence: "monthly",
			items: [
				{
					id: "owner/tool",
					kind: "mcp",
					name: "Tool",
					reason: "Complements your setup",
					credential: "must-not-render",
				},
				{ id: "unknown", kind: "memory", name: "Private context" },
			],
		});

		expect(result.cadence).toBe("monthly");
		expect(result.items).toEqual([
			{
				description: null,
				iconUrl: null,
				id: "owner/tool",
				installed: false,
				kind: "mcp",
				name: "Tool",
				reason: "Complements your setup",
			},
		]);
		expect(JSON.stringify(result)).not.toContain("credential");
	});

	test("uses the safe defaults and closes cadence values", () => {
		expect(normalizeRecommendations({ cadence: "hourly" })).toEqual({
			cadence: "weekly",
			enabled: true,
			hidden: false,
			items: [],
		});
		expect(
			normalizeRecommendations({ enabled: false, hidden: true }).enabled
		).toBe(false);
	});
});

test("normalization keeps valid rows and the nullish icon alias contract", () => {
	const result = normalizeRecommendations({
		items: [
			{
				id: "  first  ",
				name: "First",
				kind: " app ",
				icon_url: null,
				iconUrl: " alias ",
				installed: "true",
				reason: " ",
			},
			{
				id: "second",
				name: "Second",
				kind: "skill",
				icon_url: " ",
				iconUrl: "ignored",
			},
			{ id: "invalid", name: "Invalid", kind: "private" },
			null,
		],
	});
	expect(result.items.map((item) => item.id)).toEqual(["first", "second"]);
	expect(result.items[0]?.iconUrl).toBe("alias");
	expect(result.items[0]?.installed).toBe(false);
	expect(result.items[0]?.reason).toBe(
		"A match for your current catalog setup."
	);
	expect(result.items[1]?.iconUrl).toBeNull();
});
