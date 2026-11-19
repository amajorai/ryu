// packages/marketplace/src/catalog/types-models.test.ts
//
// The model task filter table, imported from its own module. The UI and the
// Desktop-to-Core adapter both read it, so its shape is a contract.

import { describe, expect, test } from "bun:test";
import * as facade from "./types.ts";
import { MODEL_CATEGORY_OPTIONS } from "./types-models.ts";

describe("types-models", () => {
	test("the facade re-exports the module's category table unchanged", () => {
		expect(facade.MODEL_CATEGORY_OPTIONS).toBe(MODEL_CATEGORY_OPTIONS);
	});

	test("only the leading all option has no pipeline tag", () => {
		const [first, ...rest] = MODEL_CATEGORY_OPTIONS;
		expect(first).toEqual({
			value: "all",
			label: "All categories",
			pipelineTag: "",
		});
		for (const option of rest) {
			expect(option.pipelineTag).not.toBe("");
		}
	});

	test("category values are unique", () => {
		const values = MODEL_CATEGORY_OPTIONS.map((option) => option.value);
		expect(new Set(values).size).toBe(values.length);
	});
});
