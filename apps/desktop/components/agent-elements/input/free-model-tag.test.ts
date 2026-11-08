import { describe, expect, it } from "bun:test";
import {
	FREE_MODEL_TAG,
	payableFreeModels,
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

describe("payableFreeModels (separate pools)", () => {
	const core = ["openai/gpt-5-mini", "anthropic/claude-sonnet-4.5"];

	it("tags only the Free models the user's pools pay for", () => {
		const credit = totalFreeCredit([
			{
				expiresAt: null,
				freeModelIds: ["OpenAI/GPT-5-mini"],
				remainingMicroUsd: 5,
			},
		]);
		expect([...(payableFreeModels(core, credit) ?? [])]).toEqual([
			"openai/gpt-5-mini",
		]);
	});

	it("keeps every Free id when the control plane did not say which pool pays", () => {
		const credit = totalFreeCredit([{ expiresAt: null, remainingMicroUsd: 5 }]);
		expect(payableFreeModels(core, credit)?.size).toBe(2);
	});

	it("tags nothing without free credit or when no pool pays for any Free id", () => {
		expect(payableFreeModels(core, null)).toBeUndefined();
		const drained = totalFreeCredit([
			{
				expiresAt: null,
				freeModelIds: ["openai/gpt-5-mini"],
				remainingMicroUsd: 0,
			},
		]);
		expect(payableFreeModels(core, drained)).toBeUndefined();
		const other = totalFreeCredit([
			{
				expiresAt: null,
				freeModelIds: ["google/gemini-2.5-flash"],
				remainingMicroUsd: 5,
			},
		]);
		expect(payableFreeModels(core, other)).toBeUndefined();
	});
});
