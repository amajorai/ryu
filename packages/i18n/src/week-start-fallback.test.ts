import { describe, expect, test } from "bun:test";

import { weekStartForLocale } from "./format-intl.ts";
import { fallbackWeekStart } from "./week-start-fallback.ts";

/** Run `body` as an engine without `Intl.Locale` (Hermes in React Native). */
function withoutIntlLocale<Result>(body: () => Result): Result {
	const saved: unknown = Reflect.get(Intl, "Locale");
	try {
		Reflect.deleteProperty(Intl, "Locale");
		return body();
	} finally {
		Reflect.set(Intl, "Locale", saved);
	}
}

describe("fallbackWeekStart", () => {
	test("reads the region, else the language's likely region", () => {
		expect(fallbackWeekStart("fr-CA")).toBe(0);
		expect(fallbackWeekStart("ar-AE")).toBe(1);
		expect(fallbackWeekStart("fa_IR")).toBe(6);
		expect(fallbackWeekStart("es-419")).toBe(1);
		expect(fallbackWeekStart("pt")).toBe(0);
		expect(fallbackWeekStart("zh-Hant")).toBe(0);
		expect(fallbackWeekStart("sv")).toBeUndefined();
		expect(fallbackWeekStart("")).toBeUndefined();
	});
});

describe("weekStartForLocale without Intl.Locale", () => {
	test("reads the CLDR week tables", () => {
		withoutIntlLocale(() => {
			expect(weekStartForLocale("de")).toBe(1);
			expect(weekStartForLocale("en-US")).toBe(0);
			expect(weekStartForLocale("en")).toBe(0);
			expect(weekStartForLocale("en-GB")).toBe(1);
			expect(weekStartForLocale("ar")).toBe(6);
			expect(weekStartForLocale("zh-Hant")).toBe(0);
			expect(weekStartForLocale("dv-MV")).toBe(5);
			expect(weekStartForLocale("nl")).toBeUndefined();
			expect(weekStartForLocale("not a locale!")).toBeUndefined();
		});
	});

	test("agrees with Intl week data where the engine has it", () => {
		const tags = ["de", "en-US", "en-GB", "ar", "ja", "pt-PT", "zh", "fa-IR"];
		const withIntl = tags.map((tag) => weekStartForLocale(tag));
		if (withIntl.every((value) => value === undefined)) {
			return;
		}
		const without = withoutIntlLocale(() =>
			tags.map((tag) => weekStartForLocale(tag))
		);
		expect(without).toEqual(withIntl);
	});
});
