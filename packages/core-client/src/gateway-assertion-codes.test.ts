import { describe, expect, test } from "bun:test";
import { readAssertionDetail } from "./gateway-assertion-codes.ts";

const BASE = {
	detail: 'found "Hello"',
	kind: "contains",
	pass: true,
	score: 1,
};

describe("readAssertionDetail", () => {
	test("reads a known code with its scalar values", () => {
		expect(
			readAssertionDetail({
				...BASE,
				code: "contains.found",
				values: { value: "Hello" },
			})
		).toEqual({
			code: "contains.found",
			negated: false,
			values: { value: "Hello" },
		});
	});

	test("reports negation and drops non-scalar values", () => {
		expect(
			readAssertionDetail({
				...BASE,
				code: "similarity.score",
				values: {
					negated: true,
					nested: { a: 1 },
					score: 0.857,
					threshold: Number.NaN,
				},
			})
		).toEqual({
			code: "similarity.score",
			negated: true,
			values: { score: 0.857 },
		});
	});

	test("a result without a known code falls back to detail", () => {
		expect(readAssertionDetail(BASE)).toBeNull();
		expect(readAssertionDetail({ ...BASE, code: "future.code" })).toBeNull();
	});
});
