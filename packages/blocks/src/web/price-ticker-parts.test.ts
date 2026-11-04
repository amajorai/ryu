import { expect, test } from "bun:test";
import { currencyAffixes } from "./price-ticker-parts.ts";

test("English keeps the published dollar prefix", () => {
	expect(currencyAffixes("en")).toEqual({ prefix: "$", suffix: "" });
	expect(currencyAffixes("en-GB")).toEqual({ prefix: "$", suffix: "" });
	expect(currencyAffixes(undefined)).toEqual({ prefix: "$", suffix: "" });
});

test("symbol-after locales put the currency in the suffix", () => {
	const german = currencyAffixes("de");
	expect(german.prefix).toBe("");
	expect(german.suffix.replace(/\s/gu, " ")).toBe(" $");
	const french = currencyAffixes("fr");
	expect(french.prefix).toBe("");
	expect(french.suffix.trim()).toBe("$US");
});

test("the affixes match the locale's full currency text", () => {
	for (const locale of ["de", "fr", "ja", "ar", "pt-BR"]) {
		const { prefix, suffix } = currencyAffixes(locale);
		const number = new Intl.NumberFormat(locale).format(129);
		const full = new Intl.NumberFormat(locale, {
			currency: "USD",
			maximumFractionDigits: 0,
			style: "currency",
		}).format(129);
		expect(`${prefix}${number}${suffix}`).toBe(full);
	}
});

test("an invalid locale falls back to the dollar prefix", () => {
	expect(currencyAffixes("not a locale!")).toEqual({ prefix: "$", suffix: "" });
});
