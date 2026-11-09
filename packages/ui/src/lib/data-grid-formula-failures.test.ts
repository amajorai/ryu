import { afterEach, expect, test } from "bun:test";
// The provider registers its runtime here; a test registers a stand-in.
import {
	type ActiveI18nRuntime,
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../i18n/src/active-locale.ts";
import { compileFormula } from "./data-grid-formula.ts";
import {
	FORMULA_FAILURE_MESSAGES,
	type FormulaFailureMessageKey,
	formulaFailureMessage,
} from "./data-grid-formula-syntax.ts";

/** A Japanese stand-in runtime: every catalog message reads "[ja] <id>". */
const japanese: ActiveI18nRuntime = {
	direction: "ltr",
	locale: "ja",
	translate: (id) => `[ja] ${id}`,
};

afterEach(() => {
	unregisterActiveI18nRuntime(japanese);
});

/** One malformed formula per fixed failure sentence. */
const MALFORMED: Record<FormulaFailureMessageKey, string> = {
	endsUnexpectedly: "1 +",
	missingBrace: "{Price * 2",
	missingClose: "(1 + 2",
	missingQuote: '"unclosed',
	nestedTooDeeply: `${"(".repeat(70)}1${")".repeat(70)}`,
	tooLong: Array.from({ length: 600 }, () => "1").join("+"),
	trailingText: "1 2",
	unexpectedClose: ")",
	unexpectedSeparator: ",",
};

test("each malformed formula fails with its table sentence in English", () => {
	for (const [key, expression] of Object.entries(MALFORMED)) {
		const result = compileFormula(expression);
		expect(result.ok).toBe(false);
		expect(result.ok ? null : result.message).toBe(
			FORMULA_FAILURE_MESSAGES[key as FormulaFailureMessageKey]
		);
	}
});

test("the failure sentences are whole, capitalized English source copy", () => {
	for (const message of Object.values(FORMULA_FAILURE_MESSAGES)) {
		expect(message).toMatch(/^[A-Z]/u);
		expect(message.trim()).toBe(message);
	}
});

test("a failure reads in the active UI language", () => {
	registerActiveI18nRuntime(japanese);
	expect(formulaFailureMessage("missingQuote")).not.toBe(
		"Missing closing quote"
	);
	const result = compileFormula('"unclosed');
	expect(result.ok ? null : result.message).toBe(
		formulaFailureMessage("missingQuote")
	);
	expect(result.ok ? null : result.message).not.toContain(
		"Missing closing quote"
	);
});
