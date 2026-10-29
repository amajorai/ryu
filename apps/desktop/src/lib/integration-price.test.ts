import { describe, expect, test } from "bun:test";
import type { IntegrationPrice } from "./api/integrations.ts";
import { providerOptionPrice } from "./integration-price.ts";

function price(overrides: Partial<IntegrationPrice>): IntegrationPrice {
	return {
		basis: null,
		confidence: "high",
		currency: "USD",
		meteredBy: [],
		per: 1,
		unit: "call",
		usd: 0.005,
		value: 0.005,
		...overrides,
	};
}

describe("providerOptionPrice", () => {
	test("an all-in price reads as the per-call price", () => {
		expect(providerOptionPrice(price({}))).toBe("$0.005 / call");
		expect(providerOptionPrice(price({ basis: "one_call" }))).toBe(
			"$0.005 / call"
		);
		expect(providerOptionPrice(price({ usd: 0, value: 0 }))).toBe("Free");
	});

	test("a base price names the meters billed on top of it", () => {
		expect(
			providerOptionPrice(
				price({
					basis: "base_call",
					meteredBy: ["results_over_10"],
					usd: 0.007,
					value: 0.007,
				})
			)
		).toBe("$0.007 / call + results over 10");
	});

	test("a usage price names its meters and no figure", () => {
		expect(
			providerOptionPrice(
				price({ basis: "usage", meteredBy: ["pages"], usd: null, value: null })
			)
		).toBe("Priced by pages");
		expect(providerOptionPrice(null)).toBe("Price not published");
	});
});
