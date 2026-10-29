import { describe, expect, it } from "bun:test";
import {
	FREE_MODEL_TAG,
	tagFreeModels,
	totalFreeCredit,
} from "./free-model-tag.ts";

describe("tagFreeModels", () => {
	it("tags exactly the shared free-eligible ids, case-insensitively", () => {
		const items = [
			{ id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
			{ id: "OpenAI/o3", name: "o3" },
			{ id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
		];
		const tagged = tagFreeModels(
			items,
			new Set(["anthropic/claude-sonnet-4.5", "openai/o3"])
		);
		expect(tagged.map((item) => item.tag ?? null)).toEqual([
			FREE_MODEL_TAG,
			FREE_MODEL_TAG,
			null,
		]);
	});

	it("leaves the list untouched without a free list", () => {
		const items = [{ id: "openai/o3", name: "o3" }];
		expect(tagFreeModels(items, undefined)).toBe(items);
		expect(tagFreeModels(items, new Set())).toBe(items);
	});
});

describe("totalFreeCredit", () => {
	it("sums every grant and keeps the nearest expiry", () => {
		expect(
			totalFreeCredit([
				{ expiresAt: "2031-01-01T00:00:00Z", remainingMicroUsd: 5_000_000 },
				{ expiresAt: null, remainingMicroUsd: 10_000_000 },
				{ expiresAt: "2030-06-01T00:00:00Z", remainingMicroUsd: 1 },
				{ expiresAt: "2029-01-01T00:00:00Z", remainingMicroUsd: 0 },
			])
		).toEqual({
			expiresAt: "2030-06-01T00:00:00Z",
			remainingMicroUsd: 15_000_001,
		});
	});

	it("is null when nothing is left", () => {
		expect(totalFreeCredit([])).toBeNull();
		expect(
			totalFreeCredit([{ expiresAt: null, remainingMicroUsd: 0 }])
		).toBeNull();
	});
});
