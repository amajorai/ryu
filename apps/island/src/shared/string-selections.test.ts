import { expect, test } from "bun:test";
import {
	groupedStringSelectionsSchema,
	stringSelectionsSchema,
} from "./string-selections.ts";

test("persisted selection decoding keeps valid siblings and arbitrary agent identifiers", () => {
	expect(
		stringSelectionsSchema.parse({
			"acp:future-engine": "future-model",
			empty: "",
			corrupt: 42,
		})
	).toEqual({ "acp:future-engine": "future-model", empty: "" });
	expect(stringSelectionsSchema.parse(null)).toEqual({});
});

test("grouped config decoding isolates corrupt agents and values", () => {
	expect(
		groupedStringSelectionsSchema.parse({
			good: { thinking: "high", broken: false },
			corrupt: "invalid",
		})
	).toEqual({ good: { thinking: "high" }, corrupt: {} });
});
