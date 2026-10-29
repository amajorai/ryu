import { describe, expect, test } from "bun:test";
// The Rust contract's fixtures are the single source of truth for both
// implementations, so they are read in place rather than copied here.
import cases from "../../../crates/gateway/contracts/fixtures/tool-catalog-cases-v1.json" with {
	type: "json",
};
import { BUILTIN_TAXONOMY } from "./capability-taxonomy.ts";
import {
	applyVerificationResult,
	BUILTIN_TOOL_CATALOG,
	builtinGeneratedToolCatalog,
	type CatalogEntry,
	catalogFreeRouteAllowed,
	catalogPaidRoutingAllowed,
	decodeCatalogEntry,
	decodeToolCatalog,
	decodeVerification,
	decodeVerificationResult,
	generatedEntriesBeside,
	MAX_EXAMPLE_BYTES,
	parseGeneratedToolCatalog,
	planVerification,
	scrubExample,
	selectCatalogEntry,
	summarizeToolkits,
	TOOL_CATALOG_VERSION,
	validateCatalogEntry,
	validateGeneratedCatalog,
	validateToolCatalog,
} from "./tool-catalog.ts";
import { BUILTIN_PRICE_CATALOG, decodePricePrecedence } from "./tool-price.ts";

const entries = new Map<string, CatalogEntry>(
	Object.entries(cases.entries).map(([name, entry]) => [
		name,
		decodeCatalogEntry(entry),
	])
);
const named = (name: string | null): CatalogEntry | null =>
	name === null ? null : (entries.get(name) ?? null);

describe("tool catalog golden cases", () => {
	test("the case file matches this contract version", () => {
		expect(cases.version).toBe(TOOL_CATALOG_VERSION);
	});

	for (const testCase of cases.validation) {
		test(`validation: ${testCase.name}`, () => {
			expect(validateCatalogEntry(decodeCatalogEntry(testCase.entry))).toEqual(
				testCase.issues
			);
		});
	}

	for (const testCase of cases.transitions) {
		test(`transition: ${testCase.name}`, () => {
			const applied = applyVerificationResult(
				decodeVerification(testCase.current),
				decodeVerificationResult(testCase.result)
			);
			expect(applied.verification).toEqual(
				decodeVerification(testCase.expected)
			);
			expect(applied.changed).toBe(testCase.changed);
		});
	}

	for (const testCase of cases.select) {
		test(`select: ${testCase.name}`, () => {
			const chosen = selectCatalogEntry(
				named(testCase.ryu),
				named(testCase.treg),
				decodePricePrecedence(testCase.precedence)
			);
			expect(chosen).toBe(named(testCase.expected));
		});
	}

	for (const testCase of cases.freeRoute) {
		test(`free route: ${testCase.name}`, () => {
			const entry = named(testCase.entry);
			expect(entry).not.toBeNull();
			const price =
				testCase.price === null
					? null
					: BUILTIN_PRICE_CATALOG.rows.find(
							(row) => row.endpoint === testCase.price
						);
			expect(catalogFreeRouteAllowed(entry as CatalogEntry, price)).toBe(
				testCase.allowed
			);
		});
	}

	for (const testCase of cases.paidRouting) {
		test(`paid routing: ${testCase.name}`, () => {
			const entry = named(testCase.entry);
			expect(entry).not.toBeNull();
			const price =
				testCase.price === null
					? null
					: BUILTIN_PRICE_CATALOG.rows.find(
							(row) => row.endpoint === testCase.price
						);
			expect(catalogPaidRoutingAllowed(entry as CatalogEntry, price)).toBe(
				testCase.allowed
			);
		});
	}
});

describe("generated tier golden cases", () => {
	for (const testCase of cases.catalogChecks) {
		test(`catalog check: ${testCase.name}`, () => {
			const issues = validateToolCatalog(
				{
					description: "",
					entries: testCase.entries.map((name) => named(name) as CatalogEntry),
					version: TOOL_CATALOG_VERSION,
				},
				BUILTIN_TAXONOMY,
				BUILTIN_PRICE_CATALOG
			);
			expect(issues).toEqual(testCase.issues);
		});
	}

	for (const testCase of cases.beside) {
		test(`beside: ${testCase.name}`, () => {
			const pick = (names: string[]) =>
				names.map((name) => named(name) as CatalogEntry);
			expect(
				generatedEntriesBeside(
					pick(testCase.curated),
					pick(testCase.generated)
				).map((entry) => entry.endpoint)
			).toEqual(testCase.expected);
		});
	}
});

describe("the built-in generated tier", () => {
	test("validates beside the curated seed", () => {
		expect(
			validateGeneratedCatalog(
				builtinGeneratedToolCatalog(),
				BUILTIN_TOOL_CATALOG,
				BUILTIN_TAXONOMY,
				BUILTIN_PRICE_CATALOG
			)
		).toEqual([]);
	});

	test("every row is generated, unverified, cites its spec and refuses paid routing", () => {
		for (const entry of builtinGeneratedToolCatalog().entries) {
			expect(entry.tier).toBe("generated");
			expect(entry.source).toBe("ryu");
			expect(entry.verification).toEqual({ state: "unverified" });
			expect(entry.spec?.url.startsWith("https://")).toBe(true);
			expect(entry.docsUrl).toBe(entry.spec?.url ?? "");
			const price = BUILTIN_PRICE_CATALOG.rows.find(
				(row) => row.endpoint === entry.endpoint
			);
			expect(catalogPaidRoutingAllowed(entry, price)).toBe(false);
		}
	});

	test("a generated file that repeats a curated row or claims a verdict is refused", () => {
		const [curated] = BUILTIN_TOOL_CATALOG.entries;
		const copy = {
			...(curated as CatalogEntry),
			tier: "curated" as const,
		};
		expect(() =>
			parseGeneratedToolCatalog({
				description: "",
				entries: [copy],
				version: TOOL_CATALOG_VERSION,
			})
		).toThrow("not_generated");
		const generated = named("generated_verified") as CatalogEntry;
		const issues = validateGeneratedCatalog(
			{ description: "", entries: [generated], version: 1 },
			BUILTIN_TOOL_CATALOG,
			BUILTIN_TAXONOMY,
			BUILTIN_PRICE_CATALOG
		);
		expect(issues.map((issue) => issue.code)).toContain(
			"generated_not_unverified"
		);
		const duplicate = named("generated_exa_search") as CatalogEntry;
		const collision = validateGeneratedCatalog(
			{
				description: "",
				entries: [{ ...duplicate, endpoint: "exa.search.auto" }],
				version: 1,
			},
			BUILTIN_TOOL_CATALOG,
			BUILTIN_TAXONOMY,
			BUILTIN_PRICE_CATALOG
		);
		expect(collision.map((issue) => issue.code)).toContain(
			"duplicate_endpoint"
		);
	});
});

describe("the built-in seed", () => {
	test("validates against the taxonomy and the price catalog", () => {
		expect(
			validateToolCatalog(
				BUILTIN_TOOL_CATALOG,
				BUILTIN_TAXONOMY,
				BUILTIN_PRICE_CATALOG
			)
		).toEqual([]);
	});

	test("seeds only native GitHub actions and vendor-priced endpoints", () => {
		const providers = new Set(
			BUILTIN_TOOL_CATALOG.entries.map((entry) => entry.provider)
		);
		expect([...providers].sort()).toEqual(["brave", "exa", "github", "tavily"]);
		for (const entry of BUILTIN_TOOL_CATALOG.entries) {
			expect(entry.source).toBe("ryu");
			expect(entry.docsUrl.startsWith("https://")).toBe(true);
		}
	});

	test("catalog-level checks catch a missing price and a dead successor", () => {
		const [first] = BUILTIN_TOOL_CATALOG.entries;
		expect(first).toBeDefined();
		const orphan = {
			...(first as CatalogEntry),
			endpoint: "github.GITHUB_NOT_PRICED",
			verification: {
				reason: "replaced",
				state: "retired" as const,
				successor: "github.GITHUB_GONE",
			},
		};
		const catalog = decodeToolCatalog({
			...BUILTIN_TOOL_CATALOG,
			entries: [...BUILTIN_TOOL_CATALOG.entries, orphan],
		});
		const issues = validateToolCatalog(
			catalog,
			BUILTIN_TAXONOMY,
			BUILTIN_PRICE_CATALOG
		).filter((issue) => issue.subject === "github.GITHUB_NOT_PRICED");
		expect(issues.map((issue) => issue.code).sort()).toEqual([
			"missing_price",
			"unknown_successor",
		]);
	});

	test("a paid probe estimate must cover one call's quote", () => {
		const exa = BUILTIN_TOOL_CATALOG.entries.find(
			(entry) => entry.endpoint === "exa.search.auto"
		) as CatalogEntry;
		const cheap = {
			...exa,
			probes: exa.probes.map((probe) =>
				probe.kind === "http" ? { ...probe, estimatedMicroUsd: 1 } : probe
			),
		};
		const issues = validateToolCatalog(
			{ ...BUILTIN_TOOL_CATALOG, entries: [cheap] },
			BUILTIN_TAXONOMY,
			BUILTIN_PRICE_CATALOG
		);
		expect(issues.map((issue) => issue.code)).toEqual(["estimate_below_quote"]);
	});

	test("the GitHub toolkit summary counts every state", () => {
		const github = summarizeToolkits(BUILTIN_TOOL_CATALOG.entries).find(
			(summary) => summary.toolkit === "github"
		);
		expect(github?.total).toBe(8);
		expect(
			(github?.verified ?? 0) +
				(github?.unverified ?? 0) +
				(github?.drifted ?? 0) +
				(github?.retired ?? 0)
		).toBe(8);
		expect(github?.ready).toBe(github?.verified === 8);
	});
});

describe("planVerification", () => {
	const all = BUILTIN_TOOL_CATALOG.entries;

	test("a zero budget runs only free probes and skips paid ones", () => {
		const plan = planVerification(all, {
			available: () => true,
			budgetMicroUsd: 0,
		});
		expect(plan.plannedMicroUsd).toBe(0);
		for (const entry of plan.entries) {
			for (const item of entry.run) {
				expect(item.cost).toBe(0);
			}
		}
		const exa = plan.entries.find(
			(entry) => entry.endpoint === "exa.search.auto"
		);
		expect(exa?.skipped.map((item) => item.reason)).toEqual(["budget"]);
		expect(exa?.run.map((item) => item.probe.kind)).toEqual(["docs_page"]);
	});

	test("a missing credential skips that probe whatever the budget", () => {
		const plan = planVerification(all, {
			available: () => false,
			budgetMicroUsd: 1_000_000,
		});
		expect(plan.plannedMicroUsd).toBe(0);
		const whoami = plan.entries.find(
			(entry) => entry.endpoint === "github.GITHUB_GET_THE_AUTHENTICATED_USER"
		);
		expect(whoami?.skipped.map((item) => item.reason)).toEqual([
			"no_credential",
		]);
	});

	test("the budget is spent cheapest first and never exceeded", () => {
		const plan = planVerification(all, {
			available: () => true,
			budgetMicroUsd: 12_000,
		});
		expect(plan.plannedMicroUsd).toBeLessThanOrEqual(12_000);
		const paid = plan.entries.flatMap((entry) =>
			entry.run.filter((item) => item.cost > 0).map(() => entry.endpoint)
		);
		// $1/1k Exa contents (1,000) and $4/1k Exa instant (4,000) and the
		// $5/1k Brave call (5,000) fit; the $7/1k Exa searches do not.
		expect(paid).toEqual([
			"exa.contents.text",
			"exa.search.instant",
			"brave.web_search",
		]);
		// Entries whose probes are all free come first.
		const firstPaid = plan.entries.findIndex((entry) =>
			entry.run.some((item) => item.cost > 0)
		);
		expect(
			plan.entries
				.slice(0, firstPaid)
				.every((entry) => entry.run.every((item) => item.cost === 0))
		).toBe(true);
		expect(plan.entries[firstPaid]?.endpoint).toBe("exa.contents.text");
	});

	test("retired entries are never planned and filters narrow the run", () => {
		const retired = {
			...(all[0] as CatalogEntry),
			verification: { reason: "withdrawn", state: "retired" as const },
		};
		expect(
			planVerification([retired], { available: () => true, budgetMicroUsd: 0 })
				.entries
		).toEqual([]);
		const github = planVerification(all, {
			available: () => true,
			budgetMicroUsd: 0,
			toolkit: "github",
		});
		expect(github.entries).toHaveLength(8);
		const one = planVerification(all, {
			available: () => true,
			budgetMicroUsd: 0,
			endpoints: ["brave.web_search"],
		});
		expect(one.entries.map((entry) => entry.endpoint)).toEqual([
			"brave.web_search",
		]);
	});
});

describe("scrubExample", () => {
	test("removes identities, secrets, free text and contact details", () => {
		const scrubbed = scrubExample({
			access_token: "gho_abcdefghijklmnopqrstuvwxyz0123",
			avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
			email: "ada@example.com",
			html_url: "https://github.com/ada/private-repo/issues/7",
			id: 583_231,
			login: "ada",
			note: "mail ada@example.com or call +44 20 7946 0958 from 10.0.0.1 with ghp_abcdefghijklmnopqrstuvwxyz",
			number: 7,
			owner: { id: 1, login: "ada", node_id: "MDQ6VXNlcjE=" },
			state: "open",
			title: "My private bug",
		}) as Record<string, unknown>;
		expect(scrubbed).toEqual({
			access_token: "<secret>",
			avatar_url: "<identity>",
			email: "<identity>",
			html_url: "https://github.com/<path>",
			id: 0,
			login: "<identity>",
			note: "mail <email> or call <phone> from <ip> with <token>",
			number: 7,
			owner: { id: 0, login: "<identity>", node_id: "<identity>" },
			state: "open",
			title: "<text>",
		});
	});

	test("is idempotent, so the control plane can scrub a scrubbed example again", () => {
		const once = scrubExample({
			html_url: "https://github.com/ada/repo/issues/7",
			login: "ada",
			note: `see https://example.com/a?b=c and ${"word ".repeat(40)}`,
		});
		expect(scrubExample(once)).toEqual(once);
	});

	test("caps arrays, depth and string length", () => {
		const scrubbed = scrubExample({
			items: [1, 2, 3, 4, 5],
			long: "word ".repeat(100),
			nested: { a: { b: { c: { d: { e: { f: 1 } } } } } },
		}) as { items: unknown[]; long: string; nested: unknown };
		expect(scrubbed.items).toEqual([1, 2, 3]);
		expect(scrubbed.long.length).toBe(121);
		expect(JSON.stringify(scrubbed.nested)).toContain("<truncated>");
	});

	test("an example still too large is replaced", () => {
		const wide = Object.fromEntries(
			Array.from({ length: 40 }, (_, index) => [
				`k${index}`,
				Array.from({ length: 3 }, () => "y ".repeat(60)),
			])
		);
		const scrubbed = scrubExample(wide);
		expect(JSON.stringify(scrubbed).length).toBeLessThanOrEqual(
			MAX_EXAMPLE_BYTES
		);
		expect(scrubbed).toEqual({ "<truncated>": true });
	});
});
