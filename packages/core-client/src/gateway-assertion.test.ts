import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { assertionSchema } from "./gateway.ts";

describe("Gateway assertion wire decoder", () => {
	test("preserves recursive authored assertions, options, and future metadata", () => {
		const authored = {
			kind: "assert_set",
			options: {
				not: false,
				config: { temperature: 0, nested: [null, true] },
				future: "keep",
			},
			assertions: [
				{ kind: "contains", value: "", future: 1 },
				{
					kind: "llm_judge",
					rubric: "check facts",
					options: { weight: 0, threshold: 0 },
				},
				{ kind: "assert_set", assertions: [{ kind: "is_json" }] },
			],
			future: { policy: "retain" },
		};
		expect(z.json().parse(assertionSchema.parse(authored))).toEqual(
			z.json().parse(authored)
		);
	});
	test("checks all three leaf contract families", () => {
		for (const kind of [
			"contains",
			"not_contains",
			"equals",
			"regex",
			"icontains",
			"starts_with",
			"contains_any",
			"contains_all",
			"icontains_any",
			"icontains_all",
			"contains_json",
			"contains_html",
			"contains_xml",
			"contains_sql",
			"levenshtein",
			"latency",
			"cost",
			"moderation",
			"javascript",
			"python",
			"ruby",
			"webhook",
			"similar",
		]) {
			expect(assertionSchema.safeParse({ kind, value: "value" }).success).toBe(
				true
			);
			expect(assertionSchema.safeParse({ kind }).success).toBe(false);
		}
		for (const kind of [
			"is_html",
			"is_xml",
			"is_sql",
			"is_refusal",
			"is_json",
			"json_valid",
		]) {
			expect(assertionSchema.safeParse({ kind }).success).toBe(true);
		}
		for (const kind of [
			"llm_judge",
			"llm_rubric",
			"factuality",
			"context_faithfulness",
			"answer_relevance",
		]) {
			expect(assertionSchema.safeParse({ kind, rubric: "" }).success).toBe(
				true
			);
			expect(assertionSchema.safeParse({ kind }).success).toBe(false);
		}
	});
	test("rejects malformed descendants and option controls without discarding them", () => {
		expect(
			assertionSchema.safeParse({
				kind: "assert_set",
				assertions: [{ kind: "contains", value: 7 }],
			}).success
		).toBe(false);
		expect(
			assertionSchema.safeParse({ kind: "is_json", options: { not: "false" } })
				.success
		).toBe(false);
		expect(assertionSchema.safeParse({ kind: "new_unsupported" }).success).toBe(
			false
		);
	});
});
