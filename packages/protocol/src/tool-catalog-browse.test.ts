import { describe, expect, test } from "bun:test";
import { BUILTIN_TAXONOMY } from "./capability-taxonomy.ts";
import cases from "./fixtures/tool-catalog-browse-cases-v1.json" with {
	type: "json",
};
import {
	type BrowseEntry,
	type BrowseInput,
	buildEndpointDetail,
	buildPlatformDetail,
	buildPlatformIndex,
	oneCallCost,
	providerDisplay,
	TOOL_CATALOG_BROWSE_VERSION,
} from "./tool-catalog-browse.ts";
import { decodePriceRecord, decodeUsdRate } from "./tool-price.ts";
import type { ReliabilityEvidence } from "./tool-reliability.ts";

const evidence = cases.input.reliability as Record<string, ReliabilityEvidence>;
const input: BrowseInput = {
	entries: cases.input.entries as BrowseEntry[],
	generatedAt: cases.input.generatedAt,
	reliability: (endpoint) => evidence[endpoint] ?? null,
	taxonomy: BUILTIN_TAXONOMY,
	usdRates: cases.input.usdRates.map(decodeUsdRate),
	version: cases.input.version,
};

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("tool catalog browse shared cases", () => {
	test("the case file matches this contract version", () => {
		expect(cases.version).toBe(TOOL_CATALOG_BROWSE_VERSION);
	});

	test("platform index", () => {
		expect(plain(buildPlatformIndex(input))).toStrictEqual(
			cases.expected.platforms
		);
	});

	test("platform detail with server-side comparison rows", () => {
		expect(plain(buildPlatformDetail(input, "web"))).toStrictEqual(
			cases.expected.platformWeb
		);
		expect(plain(buildPlatformDetail(input, "github"))).toStrictEqual(
			cases.expected.platformGithub
		);
	});

	test("endpoint detail, retired endpoints included", () => {
		expect(
			plain(buildEndpointDetail(input, "github.GITHUB_LIST_REPOSITORY_ISSUES"))
		).toStrictEqual(cases.expected.endpointRetired);
		expect(plain(buildEndpointDetail(input, "brave.web_search"))).toStrictEqual(
			cases.expected.endpointBrave
		);
	});
});

describe("tool catalog browse rules", () => {
	test("unknown platforms and endpoints are absent", () => {
		expect(buildPlatformDetail(input, "nowhere")).toBeNull();
		expect(buildEndpointDetail(input, "nowhere.at.all")).toBeNull();
	});

	test("retired endpoints never count or appear in platform views", () => {
		const github = buildPlatformDetail(input, "github");
		const ids = github?.domains.flatMap((domain) =>
			domain.rows.flatMap((row) => row.endpoints.map((view) => view.id))
		);
		expect(ids).toStrictEqual(["github.GITHUB_GET_AN_ISSUE"]);
		expect(github?.endpoints).toBe(1);
	});

	test("a row lists usable endpoints before drifted ones", () => {
		const web = buildPlatformDetail(input, "web");
		const search = web?.domains
			.flatMap((domain) => domain.rows)
			.find((row) => row.comparison_key === "web/web.search");
		expect(search?.endpoints.at(-1)?.id).toBe("exa.search.fast");
		expect(search?.endpoints.at(-1)?.platform_eligible).toBe(false);
	});

	test("an unverified price has no one-call figure", () => {
		const record = decodePriceRecord({
			confidence: "low",
			endpoint: "acme.lookup",
			price: {
				components: [{ microAmount: 5000, per: 1, rule: "per_call" }],
				type: "metered",
				unit: "USD",
			},
			provenance: "unverified",
			provider: "acme",
			source: "ryu",
		});
		const cost = oneCallCost(record, []);
		expect(cost?.usd).toBeNull();
		expect(cost?.value).toBeNull();
	});

	test("a vendor credit converts only through a verified rate", () => {
		const record = decodePriceRecord({
			checkedOn: "2026-10-20",
			confidence: "high",
			endpoint: "acme.lookup",
			price: {
				components: [{ microAmount: 2_000_000, per: 1, rule: "per_call" }],
				type: "metered",
				unit: "acme_credit",
			},
			provenance: "vendor_page",
			provider: "acme",
			source: "ryu",
			sourceUrl: "https://acme.example/pricing",
		});
		const cost = oneCallCost(record, []);
		expect(cost?.value).toBe(2);
		expect(cost?.usd).toBeNull();
	});

	test("a generated row cites its spec and operation, unpriced, and stays out of platform views without a job", () => {
		const generated: BrowseEntry = {
			capability: null,
			docsUrl: "https://specs.vendor.example/openapi.json",
			endpoint: "acme.list_widgets",
			model: null,
			operation: { method: "GET", path: "/widgets" },
			paidRoutingAllowed: false,
			platform: null,
			price: null,
			provider: "acme",
			source: "ryu",
			spec: {
				checkedOn: "2026-10-21",
				sha256: "a".repeat(64),
				url: "https://specs.vendor.example/openapi.json",
			},
			tier: "generated",
			title: "List widgets",
			toolkit: null,
			verification: { state: "unverified" },
		};
		const withGenerated = { ...input, entries: [...input.entries, generated] };
		const detail = buildEndpointDetail(withGenerated, "acme.list_widgets");
		expect(detail?.endpoint.tier).toBe("generated");
		expect(detail?.endpoint.cost).toBeNull();
		expect(detail?.endpoint.paid_routing_allowed).toBe(false);
		expect(detail?.endpoint.operation).toStrictEqual({
			method: "GET",
			path: "/widgets",
		});
		expect(detail?.endpoint.spec).toStrictEqual({
			checked_on: "2026-10-21",
			sha256: "a".repeat(64),
			url: "https://specs.vendor.example/openapi.json",
		});
		expect(plain(buildPlatformIndex(withGenerated))).toStrictEqual(
			cases.expected.platforms
		);
	});

	test("provider display names", () => {
		expect(providerDisplay("github")).toBe("GitHub");
		expect(providerDisplay("open-weather_map")).toBe("Open Weather Map");
	});
});
