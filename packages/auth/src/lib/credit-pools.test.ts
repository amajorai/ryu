import { describe, expect, it } from "bun:test";
import {
	ALL_CREDIT_POOLS,
	CREDIT_POOL_IDS,
	CREDIT_POOLS,
	isCreditPoolId,
	isOwnSupplyPool,
	OWN_SUPPLY_POOLS,
	poolForGatewayProvider,
} from "./credit-pools.ts";

/**
 * The pool catalog is pure data plus one reverse index, but three of its
 * properties are load-bearing for money: every id resolves to a pool, no two
 * pools claim the same gateway provider (which would make burn-down ambiguous),
 * and an unknown provider attributes to NOTHING rather than defaulting into some
 * pool's grants.
 */

describe("CREDIT_POOLS", () => {
	it("has a row per id, keyed consistently", () => {
		expect(ALL_CREDIT_POOLS).toHaveLength(CREDIT_POOL_IDS.length);
		for (const id of CREDIT_POOL_IDS) {
			expect(CREDIT_POOLS[id].id).toBe(id);
			expect(CREDIT_POOLS[id].label.length).toBeGreaterThan(0);
		}
	});

	it("never names a vendor in the user-facing label", () => {
		// Users buy "Ryu Credits" and pick a speed tier; the supplier behind a pool
		// must be swappable without changing what anyone was promised.
		for (const pool of ALL_CREDIT_POOLS) {
			const label = pool.label.toLowerCase();
			for (const vendor of [
				"bedrock",
				"cloudflare",
				"openrouter",
				"aws",
				"openai",
				"gpt",
				"google",
				"gcp",
				"vertex",
				"gemini",
			]) {
				expect(label).not.toContain(vendor);
			}
		}
	});

	it("gives every pool a DISTINCT label", () => {
		// Not cosmetic: `useCreditGrants` indexes label → pool id, and the campaigns
		// API aggregates a wallet's grants BY LABEL. Two pools sharing one would
		// merge two segregated balances into a single row — segregation broken in
		// the one place a user looks, with nothing raised anywhere.
		const labels = ALL_CREDIT_POOLS.map((pool) => pool.label);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it("carries the donated ceilings, with 0 meaning uncapped", () => {
		expect(CREDIT_POOLS.cloudflare.budgetCeilingMicroUsd).toBe(10_000_000_000);
		expect(CREDIT_POOLS.bedrock.budgetCeilingMicroUsd).toBe(10_000_000_000);
		expect(CREDIT_POOLS.vertex.budgetCeilingMicroUsd).toBe(2_500_000_000);
		expect(CREDIT_POOLS["openai-credits"].budgetCeilingMicroUsd).toBe(
			1_000_000_000
		);
		expect(CREDIT_POOLS["anthropic-credits"].budgetCeilingMicroUsd).toBe(
			3_000_000_000
		);
		expect(CREDIT_POOLS.openrouter.budgetCeilingMicroUsd).toBe(0);
	});

	it("caps every frontier pool Ryu holds credit for", () => {
		// 0 is UNCAPPED, and a held pool with no ceiling has no brake at all:
		// `reservePoolBudget` would issue grants against an unmeasured allowance.
		for (const pool of [
			CREDIT_POOLS.vertex,
			CREDIT_POOLS["openai-credits"],
			CREDIT_POOLS["anthropic-credits"],
		]) {
			expect(pool.budgetCeilingMicroUsd).toBeGreaterThan(0);
			expect(pool.tier).toBe("frontier");
			expect(pool.visible).toBe(true);
		}
	});

	it("claims each gateway provider at most once", () => {
		const seen = new Set<string>();
		for (const pool of ALL_CREDIT_POOLS) {
			for (const provider of pool.gatewayProviders) {
				expect(seen.has(provider)).toBe(false);
				seen.add(provider);
			}
		}
	});
});

describe("poolForGatewayProvider", () => {
	it("maps a registry id to its pool", () => {
		expect(poolForGatewayProvider("bedrock")).toBe("bedrock");
		expect(poolForGatewayProvider("cloudflare")).toBe("cloudflare");
		expect(poolForGatewayProvider("openrouter")).toBe("openrouter");
		expect(poolForGatewayProvider("vertex")).toBe("vertex");
		expect(poolForGatewayProvider("openai-credits")).toBe("openai-credits");
		expect(poolForGatewayProvider("anthropic-credits")).toBe(
			"anthropic-credits"
		);
	});

	it("returns null for an untagged provider instead of guessing", () => {
		// An untagged provider debits exactly as it did before pools existed.
		//
		// `openai` is the load-bearing one now that a donated OpenAI allowance
		// exists: that registry id serves whatever key the NODE OPERATOR
		// configured (and `gpt-` / `o1` / `o3` / `o4` route to it), so it must stay
		// unattributed. The donated supply is `openai-credits`, a separate registry
		// slot, precisely so own-key traffic can never draw the donation down.
		expect(poolForGatewayProvider("openai")).toBeNull();
		expect(poolForGatewayProvider("anthropic")).toBeNull();
		// Same shape for Google: `genai` is the AI Studio surface an operator points
		// at their own key; only `vertex` is donated.
		expect(poolForGatewayProvider("genai")).toBeNull();
		expect(poolForGatewayProvider("")).toBeNull();
	});

	it("is case- and whitespace-exact (a near miss attributes nothing)", () => {
		expect(poolForGatewayProvider("Bedrock")).toBeNull();
		expect(poolForGatewayProvider(" bedrock")).toBeNull();
	});
});

describe("isCreditPoolId", () => {
	it("accepts catalog ids and rejects anything else", () => {
		expect(isCreditPoolId("bedrock")).toBe(true);
		expect(isCreditPoolId("vertex")).toBe(true);
		expect(isCreditPoolId("openai-credits")).toBe(true);
		// The gateway's own-key slots are providers, never pool ids — a grant
		// carrying one would be money no debit can ever reach.
		expect(isCreditPoolId("openai")).toBe(false);
		expect(isCreditPoolId("nope")).toBe(false);
		// Inherited object members are not pool ids.
		expect(isCreditPoolId("toString")).toBe(false);
		expect(isCreditPoolId("constructor")).toBe(false);
	});
});

describe("isOwnSupplyPool", () => {
	it("is every pool but the retail pass-through, and nothing unknown", () => {
		expect(OWN_SUPPLY_POOLS.map((pool) => pool.id)).toEqual([
			"cloudflare",
			"bedrock",
			"vertex",
			"openai-credits",
			"anthropic-credits",
		]);
		expect(isOwnSupplyPool("openrouter")).toBe(false);
		expect(isOwnSupplyPool("openai")).toBe(false);
		expect(isOwnSupplyPool(null)).toBe(false);
		expect(isOwnSupplyPool(undefined)).toBe(false);
	});
});
