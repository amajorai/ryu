import { describe, expect, test } from "bun:test";
// The Rust contract's fixtures are the single source of truth for both
// implementations, so they are read in place rather than copied here.
import cases from "../../../crates/gateway/contracts/fixtures/capability-taxonomy-cases-v1.json" with {
	type: "json",
};
import {
	BUILTIN_TAXONOMY,
	capabilityForVerb,
	comparisonKey,
	decodeTaxonomy,
	isValidIsoDate,
	meaningKey,
	resolveCapability,
	TAXONOMY_VERSION,
	type TaxonomyIssue,
	validateTaxonomy,
} from "./capability-taxonomy.ts";

const byCodeThenSubject = (left: TaxonomyIssue, right: TaxonomyIssue) =>
	left.code === right.code
		? left.subject.localeCompare(right.subject)
		: left.code.localeCompare(right.code);

describe("capability taxonomy golden cases", () => {
	test("the case file matches this contract version", () => {
		expect(cases.version).toBe(TAXONOMY_VERSION);
	});

	for (const testCase of cases.validation) {
		test(`validation: ${testCase.name}`, () => {
			const actual = validateTaxonomy(decodeTaxonomy(testCase.taxonomy));
			expect([...actual].sort(byCodeThenSubject)).toEqual(
				[...testCase.issues].sort(byCodeThenSubject)
			);
		});
	}

	for (const testCase of cases.resolve) {
		test(`resolve: ${testCase.name}`, () => {
			expect(resolveCapability(BUILTIN_TAXONOMY, testCase.id)?.id ?? null).toBe(
				testCase.expected
			);
		});
	}

	for (const testCase of cases.comparison) {
		test(`comparison: ${testCase.name}`, () => {
			const result = comparisonKey(
				BUILTIN_TAXONOMY,
				testCase.platform,
				testCase.capability,
				testCase.model
			);
			const actual: unknown = result.ok
				? { key: result.key }
				: { error: result.error };
			expect(actual).toEqual(testCase.expected);
		});
	}
});

describe("built-in taxonomy", () => {
	test("is valid and covers the facade verbs once each", () => {
		expect(validateTaxonomy(BUILTIN_TAXONOMY)).toEqual([]);
		const verbs = BUILTIN_TAXONOMY.capabilities.flatMap(
			(capability) => capability.verbs
		);
		expect(new Set(verbs).size).toBe(verbs.length);
		expect(capabilityForVerb(BUILTIN_TAXONOMY, "web.search")?.layer).toBe(
			"web.search"
		);
		expect(capabilityForVerb(BUILTIN_TAXONOMY, "browser.click")?.layer).toBe(
			"browser.control"
		);
	});

	test("meaning keys and dates match the Rust rules", () => {
		expect(meaningKey("Search the web")).toBe("search web");
		expect(meaningKey("Web searches")).toBe("search web");
		expect(meaningKey("List a project's issues")).toBe("issue list project");
		expect(meaningKey("List repositories")).toBe("list repository");
		expect(meaningKey("Addresses")).toBe("address");
		expect(isValidIsoDate("2024-02-29")).toBe(true);
		expect(isValidIsoDate("2026-02-29")).toBe(false);
		expect(isValidIsoDate("2026-1-01")).toBe(false);
	});
});
