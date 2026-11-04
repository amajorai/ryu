import { describe, expect, test } from "bun:test";
import { formatMessage } from "./format.ts";
import {
	formatCompactAge,
	formatRelativeTime,
	relativeTimeFormatter,
} from "./format-intl.ts";
import { formatList } from "./format-list.ts";
import {
	fallbackPluralCategory,
	hasIntl,
	joinListFallback,
	pluralRules,
} from "./intl-guards.ts";
import { formatRelativeFallback } from "./intl-relative-fallback.ts";

const MISSING = ["PluralRules", "ListFormat", "RelativeTimeFormat"] as const;
const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);
const MINUTE_MS = 60_000;

/** Run `body` as an engine without the three optional `Intl` constructors (Hermes). */
function withoutOptionalIntl<Result>(body: () => Result): Result {
	const saved = MISSING.map((name) => [name, Reflect.get(Intl, name)] as const);
	try {
		for (const name of MISSING) {
			Reflect.deleteProperty(Intl, name);
		}
		return body();
	} finally {
		for (const [name, value] of saved) {
			Reflect.set(Intl, name, value);
		}
	}
}

const PLURAL = "{count, plural, one {# item} other {# items}}";
const ALL_FORMS =
	"{n, plural, zero {zero} one {one} two {two} few {few} many {many} other {other}}";

describe("formatters without PluralRules, ListFormat or RelativeTimeFormat", () => {
	test("hasIntl reports the missing constructors and restores them", () => {
		withoutOptionalIntl(() => {
			for (const name of MISSING) {
				expect(hasIntl(name)).toBe(false);
			}
		});
		for (const name of MISSING) {
			expect(hasIntl(name)).toBe(true);
		}
	});

	test("ICU plurals select a form instead of throwing (fresh locales, so nothing is cached)", () => {
		withoutOptionalIntl(() => {
			expect(formatMessage(PLURAL, { count: 1 }, "en-x-guard")).toBe("1 item");
			expect(formatMessage(PLURAL, { count: 5 }, "en-x-guard")).toBe("5 items");
			expect(formatMessage(ALL_FORMS, { n: 1 }, "ru-x-guard")).toBe("one");
			expect(formatMessage(ALL_FORMS, { n: 3 }, "ru-x-guard")).toBe("few");
			expect(formatMessage(ALL_FORMS, { n: 5 }, "ru-x-guard")).toBe("many");
			expect(formatMessage(PLURAL, { count: 5 }, "ru-x-guard")).toBe("5 items");
			expect(formatMessage(PLURAL, { count: 1 }, "ja-x-guard")).toBe("1 items");
			expect(formatMessage(ALL_FORMS, { n: 0 }, "ar-x-guard")).toBe("zero");
			expect(formatMessage(ALL_FORMS, { n: 2 }, "ar-x-guard")).toBe("two");
			expect(formatMessage(ALL_FORMS, { n: 11 }, "ar-x-guard")).toBe("many");
			expect(formatMessage(PLURAL, { count: 1 }, "de-x-guard")).toBe("1 item");
			// The real installs message: its `=0` branch still wins.
			const installs =
				"{count, plural, =0 {No installs} one {# install} other {# installs}}";
			expect(formatMessage(installs, { count: 0 }, "en-x-guard")).toBe(
				"No installs"
			);
			expect(
				formatMessage(
					"{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
					{ n: 22 },
					"en-x-guard"
				)
			).toBe("22nd");
		});
	});

	test("lists join plainly instead of throwing", () => {
		withoutOptionalIntl(() => {
			expect(formatList(["a", "b"], "conjunction", "de")).toBe("a, b");
			// English keeps the exact Intl shape, so its meaning ("or") survives.
			expect(formatList(["a", "b", "c"], "conjunction", "en")).toBe(
				"a, b, and c"
			);
			expect(formatList(["a", "b"], "disjunction", "en-GB")).toBe("a or b");
			expect(formatList(["a", "b", "c"], "disjunction", null)).toBe(
				"a, b, or c"
			);
			expect(formatList(["a", "b"], "unit", "en")).toBe("a, b");
			expect(formatList(["only"], "conjunction", "en")).toBe("only");
			expect(formatList([], "disjunction", "en")).toBe("");
			expect(formatList(["a", "b"], "conjunction", "not a locale")).toBe(
				"a, b"
			);
			expect(formatList(["モデル", "地域"], "conjunction", "ja")).toBe(
				"モデル、地域"
			);
		});
	});

	test("relative ages degrade to the English compact form instead of throwing", () => {
		withoutOptionalIntl(() => {
			expect(
				formatCompactAge("de-x-guard", NOW - 5 * MINUTE_MS, { now: NOW })
			).toBeString();
			expect(formatCompactAge("ja-x-guard", NOW - 10_000, { now: NOW })).toBe(
				"now"
			);
			expect(
				formatRelativeTime("fr-x-guard", NOW - 5 * MINUTE_MS, { now: NOW })
			).toBe("5m ago");
			expect(
				relativeTimeFormatter("es-x-guard", "long", "always").format(2, "days")
			).toBe("in 2d");
		});
	});

	test("the real constructors are still used when present", () => {
		expect(pluralRules("en", "cardinal")).toBeInstanceOf(Intl.PluralRules);
		expect(() => pluralRules("not a locale", "cardinal")).toThrow();
		expect(formatList(["a", "b"], "conjunction", "en")).toBe("a and b");
	});
});

describe("fallback tables", () => {
	test("CLDR cardinal categories for the shipped languages", () => {
		const cases: [string, number, Intl.LDMLPluralRule][] = [
			["en", 1, "one"],
			["en", 0, "other"],
			["en", 1.5, "other"],
			["de", 1, "one"],
			["fr", 0, "one"],
			["fr", 1.5, "one"],
			["pt-BR", 2, "other"],
			["hi", 0, "one"],
			["hi", 1, "one"],
			["hi", 1.5, "other"],
			["hi", 2, "other"],
			["ja", 1, "other"],
			["zh-CN", 1, "other"],
			["ko", 1, "other"],
			["ru", 21, "one"],
			["ru", 11, "many"],
			["ru", 22, "few"],
			["ru", 12, "many"],
			["ru", 1.5, "other"],
			["pl", 21, "many"],
			["pl", 1, "one"],
			["ar", 0, "zero"],
			["ar", 2, "two"],
			["ar", 105, "few"],
			["ar", 111, "many"],
			["ar", 100, "other"],
		];
		for (const [locale, count, category] of cases) {
			expect([locale, count, fallbackPluralCategory(locale, count)]).toEqual([
				locale,
				count,
				category,
			]);
		}
	});

	test("the degraded relative formatter and list join", () => {
		expect(formatRelativeFallback(-3, "hour")).toBe("3h ago");
		expect(formatRelativeFallback(4, "months")).toBe("in 4mo");
		expect(formatRelativeFallback(0, "second")).toBe("now");
		expect(joinListFallback(["a", "b", "c"], "en")).toBe("a, b, c");
		expect(joinListFallback(["a", "b", "c"], "en", "conjunction")).toBe(
			"a, b, and c"
		);
		expect(joinListFallback(["a", "b"], "ru", "disjunction")).toBe("a, b");
		expect(joinListFallback(["一", "二"], "zh-CN")).toBe("一、二");
	});
});
