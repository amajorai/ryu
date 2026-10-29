import { describe, expect, test } from "bun:test";
// The Rust contract's fixtures are the single source of truth for both
// implementations, so they are read in place rather than copied here.
import cases from "../../../crates/gateway/contracts/fixtures/tool-price-cases-v1.json" with {
	type: "json",
};
import {
	BUILTIN_PRICE_CATALOG,
	DEFAULT_PRICE_PRECEDENCE,
	decodePricePrecedence,
	decodePriceRecord,
	decodePriceUsage,
	decodeUsdRate,
	isValidEndpointId,
	type PriceRecord,
	paidRoutingAllowed,
	quoteCatalogEndpoint,
	quotePrice,
	selectPrice,
	TOOL_PRICE_VERSION,
	validatePriceRecord,
} from "./tool-price.ts";

const rates = cases.usdRates.map(decodeUsdRate);
const records = new Map<string, PriceRecord>(
	Object.entries(cases.records).map(([name, record]) => [
		name,
		decodePriceRecord(record),
	])
);
const named = (name: string | null): PriceRecord | null =>
	name === null ? null : (records.get(name) ?? null);

describe("tool price golden cases", () => {
	test("the case file matches this contract version", () => {
		expect(cases.version).toBe(TOOL_PRICE_VERSION);
	});

	for (const testCase of cases.validation) {
		test(`validation: ${testCase.name}`, () => {
			expect(validatePriceRecord(decodePriceRecord(testCase.record))).toEqual(
				[...testCase.issues].sort()
			);
		});
	}

	for (const testCase of cases.quote) {
		test(`quote: ${testCase.name}`, () => {
			const result = quotePrice(
				decodePriceRecord(testCase.record),
				decodePriceUsage(testCase.usage),
				rates
			);
			const actual: unknown = result.ok
				? { free: result.free, microUsd: result.microUsd }
				: { error: result.error };
			expect(actual).toEqual(testCase.expected);
		});
	}

	for (const testCase of cases.select) {
		test(`select: ${testCase.name}`, () => {
			const selected = selectPrice(
				named(testCase.ryu),
				named(testCase.treg),
				decodePricePrecedence(testCase.precedence)
			);
			const label: string | null = selected?.source ?? null;
			expect(label).toBe(testCase.expected);
		});
	}
});

describe("built-in price catalog", () => {
	const oneCall = decodePriceUsage({ calls: 1 });

	test("defaults to Ryu's verified record, else Treg's", () => {
		expect(DEFAULT_PRICE_PRECEDENCE).toBe("ryu_verified_first");
	});

	test("every row is dated and cited, and verified unless its page dropped it", () => {
		expect(BUILTIN_PRICE_CATALOG.rows.length).toBeGreaterThanOrEqual(10);
		// Rows whose cited page no longer shows the price: unverified, so they
		// never route a paid call. Adding one is a deliberate change.
		const dropped = new Set(["exa.search.fast"]);
		for (const row of BUILTIN_PRICE_CATALOG.rows) {
			expect(paidRoutingAllowed(row)).toBe(!dropped.has(row.endpoint));
			if (dropped.has(row.endpoint)) {
				expect(row.provenance).toBe("unverified");
				expect(row.confidence).toBe("low");
			}
			expect(row.checkedOn).toBeDefined();
			expect(row.sourceUrl).toBeDefined();
		}
	});

	test("quotes native units through the USD rate table", () => {
		expect(
			quoteCatalogEndpoint(
				BUILTIN_PRICE_CATALOG,
				"tavily.search.basic",
				oneCall
			)
		).toEqual({ free: false, microUsd: 8000, ok: true });
		expect(
			quoteCatalogEndpoint(
				BUILTIN_PRICE_CATALOG,
				"composio.tool_call.managed_app",
				oneCall
			)
		).toEqual({ free: false, microUsd: 500, ok: true });
		expect(
			quoteCatalogEndpoint(
				BUILTIN_PRICE_CATALOG,
				"github.GITHUB_CREATE_AN_ISSUE",
				oneCall
			)
		).toEqual({ free: true, microUsd: 0, ok: true });
		expect(
			quoteCatalogEndpoint(BUILTIN_PRICE_CATALOG, "nope.endpoint", oneCall)
		).toBeNull();
	});

	test("endpoint id grammar", () => {
		expect(isValidEndpointId("github.GITHUB_CREATE_AN_ISSUE")).toBe(true);
		expect(isValidEndpointId("github")).toBe(false);
		expect(isValidEndpointId("GitHub.x")).toBe(false);
		expect(isValidEndpointId("github..x")).toBe(false);
	});
});
