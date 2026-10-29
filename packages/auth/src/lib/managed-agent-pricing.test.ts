import { describe, expect, it } from "bun:test";
import {
	findManagedAgentRate,
	MANAGED_AGENT_CONTAINER_RATES,
	MANAGED_AGENT_PRICING_VERSION,
	MANAGED_AGENT_RATE_CARD,
	type ManagedAgentPricedUsage,
	type ManagedAgentRateCardEntry,
	priceManagedAgentUsage,
} from "./managed-agent-pricing.ts";

const NO_USAGE: ManagedAgentPricedUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadInputTokens: 0,
	cacheWrite5mInputTokens: 0,
	cacheWrite1hInputTokens: 0,
	webSearchRequests: 0,
	fileSearchCalls: 0,
	groundingCalls: 0,
	container: null,
};

function usageOf(
	overrides: Partial<ManagedAgentPricedUsage>
): ManagedAgentPricedUsage {
	return { ...NO_USAGE, ...overrides };
}

function requireRate(
	backend: string,
	model: string,
	at: string
): ManagedAgentRateCardEntry {
	const entry = findManagedAgentRate(backend, model, new Date(at));
	if (entry === null) {
		throw new Error(`no rate for ${backend}/${model} at ${at}`);
	}
	return entry;
}

const OPENAI_TEST_ENTRY: ManagedAgentRateCardEntry = {
	backend: "openai",
	model: "test-model",
	effectiveFrom: "2026-01-01T00:00:00Z",
	effectiveUntil: null,
	inputMicroUsdPerMTok: 2_000_000,
	outputMicroUsdPerMTok: 8_000_000,
	cacheReadMicroUsdPerMTok: 500_000,
	cacheWrite5mMicroUsdPerMTok: null,
	cacheWrite1hMicroUsdPerMTok: null,
	webSearchMicroUsdPerCall: 10_000,
	fileSearchMicroUsdPerCall: 2500,
	groundingMicroUsdPerCall: null,
	source: "https://example.com/pricing",
	verifiedAt: "2026-10-10",
};

describe("managed agent rate card", () => {
	it("is version 1 and every entry is sourced, dated and non-negative", () => {
		expect(MANAGED_AGENT_PRICING_VERSION).toBe(1);
		expect(MANAGED_AGENT_RATE_CARD.length).toBeGreaterThan(0);
		for (const entry of MANAGED_AGENT_RATE_CARD) {
			expect(entry.source.startsWith("https://")).toBe(true);
			expect(entry.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
			expect(Number.isFinite(Date.parse(entry.effectiveFrom))).toBe(true);
			if (entry.effectiveUntil !== null) {
				expect(Date.parse(entry.effectiveUntil)).toBeGreaterThan(
					Date.parse(entry.effectiveFrom)
				);
			}
			const prices = [
				entry.inputMicroUsdPerMTok,
				entry.outputMicroUsdPerMTok,
				entry.cacheReadMicroUsdPerMTok,
				entry.cacheWrite5mMicroUsdPerMTok ?? 0,
				entry.cacheWrite1hMicroUsdPerMTok ?? 0,
				entry.webSearchMicroUsdPerCall ?? 0,
				entry.fileSearchMicroUsdPerCall ?? 0,
				entry.groundingMicroUsdPerCall ?? 0,
			];
			for (const price of prices) {
				expect(Number.isSafeInteger(price) && price >= 0).toBe(true);
			}
		}
	});

	it("never has two entries for one model in effect at the same time", () => {
		const byModel = new Map<string, ManagedAgentRateCardEntry[]>();
		for (const entry of MANAGED_AGENT_RATE_CARD) {
			const key = `${entry.backend}/${entry.model}`;
			byModel.set(key, [...(byModel.get(key) ?? []), entry]);
		}
		for (const entries of byModel.values()) {
			const sorted = [...entries].sort(
				(left, right) =>
					Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom)
			);
			for (const [index, entry] of sorted.entries()) {
				const next = sorted[index + 1];
				if (next !== undefined) {
					expect(entry.effectiveUntil).not.toBeNull();
					expect(Date.parse(entry.effectiveUntil ?? "")).toBeLessThanOrEqual(
						Date.parse(next.effectiveFrom)
					);
				}
			}
		}
	});

	it("selects the Gemini entry by effective date at the 2027-01-01 boundary", () => {
		const before = requireRate(
			"gemini",
			"gemini-3.8-flash",
			"2026-12-31T23:59:59.999Z"
		);
		expect(before.inputMicroUsdPerMTok).toBe(750_000);
		expect(before.outputMicroUsdPerMTok).toBe(3_750_000);
		expect(before.cacheReadMicroUsdPerMTok).toBe(75_000);

		const after = requireRate(
			"gemini",
			"gemini-3.8-flash",
			"2027-01-01T00:00:00.000Z"
		);
		expect(after.inputMicroUsdPerMTok).toBe(1_500_000);
		expect(after.outputMicroUsdPerMTok).toBe(7_500_000);
		expect(after.cacheReadMicroUsdPerMTok).toBe(150_000);

		const sixFlash = requireRate(
			"gemini",
			"gemini-3.6-flash",
			"2027-06-01T00:00:00Z"
		);
		expect(sixFlash.inputMicroUsdPerMTok).toBe(1_500_000);

		const lite = requireRate(
			"gemini",
			"gemini-3.5-flash-lite",
			"2030-01-01T00:00:00Z"
		);
		expect(lite.inputMicroUsdPerMTok).toBe(300_000);
		expect(lite.outputMicroUsdPerMTok).toBe(2_500_000);
		expect(lite.cacheReadMicroUsdPerMTok).toBe(30_000);
		expect(lite.groundingMicroUsdPerCall).toBe(14_000);
	});

	it("returns null for unknown models, wrong backends, invalid dates and times before the card", () => {
		expect(
			findManagedAgentRate("openai", "gpt-unknown", new Date("2026-11-01"))
		).toBeNull();
		expect(
			findManagedAgentRate("openai", "gemini-3.8-flash", new Date("2026-11-01"))
		).toBeNull();
		expect(
			findManagedAgentRate("gemini", "GEMINI-3.8-FLASH", new Date("2026-11-01"))
		).toBeNull();
		expect(
			findManagedAgentRate(
				"ryu_node",
				"gemini-3.8-flash",
				new Date("2026-11-01")
			)
		).toBeNull();
		expect(
			findManagedAgentRate("gemini", "gemini-3.8-flash", new Date("not a date"))
		).toBeNull();
		expect(
			findManagedAgentRate("gemini", "gemini-3.8-flash", new Date("2026-10-09"))
		).toBeNull();
	});

	it("leaves OpenAI models with prompt-length price tiers unpriced", () => {
		const at = new Date("2026-11-01T00:00:00Z");
		for (const model of ["gpt-6-sol", "gpt-5.6-sol", "gpt-5.5", "gpt-5.4"]) {
			expect(findManagedAgentRate("openai", model, at)).toBeNull();
		}
		expect(findManagedAgentRate("openai", "gpt-5.4-mini", at)).not.toBeNull();
	});

	it("prices Anthropic Opus 5.5 at the published list rates", () => {
		const entry = requireRate(
			"anthropic",
			"claude-opus-5-5",
			"2026-11-01T00:00:00Z"
		);
		// 1M input $4 + 1M output $20 + 1M cache read $0.20 + 1M 5m write $5 + 1M 1h write $8
		// + 3 searches $0.03 = $37.23
		expect(
			priceManagedAgentUsage(
				entry,
				usageOf({
					inputTokens: 1_000_000,
					outputTokens: 1_000_000,
					cacheReadInputTokens: 1_000_000,
					cacheWrite5mInputTokens: 1_000_000,
					cacheWrite1hInputTokens: 1_000_000,
					webSearchRequests: 3,
				})
			)
		).toBe(37_230_000);
	});

	it("charges OpenAI cached tokens once, at the cache-read rate", () => {
		const entry = requireRate("openai", "gpt-5.4-mini", "2026-11-01T00:00:00Z");
		// Vendor report: input_tokens 10,000 of which 4,000 cached and 1,000 cache writes. The
		// adapter passes the uncached remainder (5,000) as inputTokens (§10.2).
		const price = priceManagedAgentUsage(
			entry,
			usageOf({
				inputTokens: 5000,
				cacheReadInputTokens: 4000,
				cacheWrite5mInputTokens: 1000,
				outputTokens: 2000,
			})
		);
		// 5,000 × 0.75 + 4,000 × 0.075 + 1,000 × 0.75 (no cache-write price) + 2,000 × 4.50,
		// all per million tokens = 3,750 + 300 + 750 + 9,000 = 13,800 micro-USD.
		expect(price).toBe(13_800);
		// The cached tokens are not also charged at the input rate.
		const doubleCharged = priceManagedAgentUsage(
			entry,
			usageOf({
				inputTokens: 10_000,
				cacheReadInputTokens: 4000,
				outputTokens: 2000,
			})
		);
		expect(price).toBeLessThan(doubleCharged);
	});

	it("sums exact rationals and rounds half up once", () => {
		// 1 input token at $2/MTok = 2 micro-USD; 1 output token at $8/MTok = 8 micro-USD.
		expect(
			priceManagedAgentUsage(
				OPENAI_TEST_ENTRY,
				usageOf({ inputTokens: 1, outputTokens: 1 })
			)
		).toBe(10);
		// 1 cached token at $0.50/MTok = 0.5 micro-USD rounds half up to 1.
		expect(
			priceManagedAgentUsage(
				OPENAI_TEST_ENTRY,
				usageOf({ cacheReadInputTokens: 1 })
			)
		).toBe(1);
		// 0.4 (input) + 0.4 (cache read) = 0.8 rounds to 1; rounding each term first would give 0.
		expect(
			priceManagedAgentUsage(
				{
					...OPENAI_TEST_ENTRY,
					inputMicroUsdPerMTok: 400_000,
					cacheReadMicroUsdPerMTok: 400_000,
				},
				usageOf({ inputTokens: 1, cacheReadInputTokens: 1 })
			)
		).toBe(1);
		const gemini = requireRate(
			"gemini",
			"gemini-3.8-flash",
			"2026-11-01T00:00:00Z"
		);
		// 5 cached tokens at $0.075/MTok = 0.375 micro-USD rounds down; 7 = 0.525 rounds up.
		expect(
			priceManagedAgentUsage(gemini, usageOf({ cacheReadInputTokens: 5 }))
		).toBe(0);
		expect(
			priceManagedAgentUsage(gemini, usageOf({ cacheReadInputTokens: 7 }))
		).toBe(1);
	});

	it("stays exact for counts whose products exceed the safe integer range", () => {
		const entry: ManagedAgentRateCardEntry = {
			...OPENAI_TEST_ENTRY,
			outputMicroUsdPerMTok: 600_000_000,
		};
		// 9e9 tokens × 600 USD per MTok = 5,400,000 USD = 5.4e12 micro-USD.
		expect(
			priceManagedAgentUsage(entry, usageOf({ outputTokens: 9_000_000_000 }))
		).toBe(5_400_000_000_000);
	});

	it("prices per-call tools from the entry and treats a null price as free", () => {
		expect(
			priceManagedAgentUsage(
				OPENAI_TEST_ENTRY,
				usageOf({ webSearchRequests: 2, fileSearchCalls: 4, groundingCalls: 9 })
			)
		).toBe(2 * 10_000 + 4 * 2500);
		const gemini = requireRate(
			"gemini",
			"gemini-3.5-flash-lite",
			"2026-11-01T00:00:00Z"
		);
		expect(
			priceManagedAgentUsage(
				gemini,
				usageOf({ groundingCalls: 3, webSearchRequests: 5 })
			)
		).toBe(42_000);
	});

	it("falls back from a missing 1h cache-write price to the 5m price, then the input price", () => {
		expect(
			priceManagedAgentUsage(
				{ ...OPENAI_TEST_ENTRY, cacheWrite5mMicroUsdPerMTok: 3_000_000 },
				usageOf({ cacheWrite1hInputTokens: 1_000_000 })
			)
		).toBe(3_000_000);
		expect(
			priceManagedAgentUsage(
				OPENAI_TEST_ENTRY,
				usageOf({ cacheWrite1hInputTokens: 1_000_000 })
			)
		).toBe(2_000_000);
	});

	it("prices containers per minute of a 20-minute session, with or without a model price", () => {
		expect(MANAGED_AGENT_CONTAINER_RATES).toEqual({
			"1g": 30_000,
			"4g": 120_000,
			"16g": 480_000,
			"64g": 1_920_000,
		});
		expect(
			priceManagedAgentUsage(
				null,
				usageOf({ container: { memoryLimit: "4g", billedMinutes: 5 } })
			)
		).toBe(30_000);
		expect(
			priceManagedAgentUsage(
				null,
				usageOf({ container: { memoryLimit: "1g", billedMinutes: 7 } })
			)
		).toBe(10_500);
		expect(
			priceManagedAgentUsage(
				null,
				usageOf({ container: { memoryLimit: "64g", billedMinutes: 20 } })
			)
		).toBe(1_920_000);
	});

	it("prices nothing but containers for an unpriced model and ignores invalid counts", () => {
		expect(
			priceManagedAgentUsage(
				null,
				usageOf({ inputTokens: 1_000_000, webSearchRequests: 3 })
			)
		).toBe(0);
		expect(
			priceManagedAgentUsage(
				OPENAI_TEST_ENTRY,
				usageOf({
					inputTokens: -5,
					outputTokens: Number.NaN,
					cacheReadInputTokens: 1.5,
					webSearchRequests: Number.POSITIVE_INFINITY,
				})
			)
		).toBe(0);
	});
});
