import { describe, expect, it } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { comparisonSections } from "../pricing-comparison.ts";
import {
	ENGLISH_PRICING_FORMAT,
	getStandaloneProductPricing,
	PRICING_COPY,
	pricingFormat,
	STANDALONE_PRODUCT_PRICING,
	standaloneProductPricing,
} from "./standalone-pricing.ts";

const literalIn =
	(locale: string): LiteralMessage =>
	(source, values) =>
		formatMessage(source, values, locale);

/** Intl separates a figure from its unit with a (narrow) no-break space. */
const plain = (text: string) => text.replace(/[  ]/gu, " ");

describe("pricing figures in the reader's locale", () => {
	it("keeps the published English copy for English and no locale", () => {
		expect(pricingFormat()).toBe(ENGLISH_PRICING_FORMAT);
		expect(pricingFormat("en-GB")).toBe(ENGLISH_PRICING_FORMAT);
		expect(standaloneProductPricing(literalIn("en"), "en")).toEqual(
			STANDALONE_PRODUCT_PRICING
		);
		expect(ENGLISH_PRICING_FORMAT.usdRate(0.025)).toBe(
			PRICING_COPY.boxSmallHour
		);
		expect(ENGLISH_PRICING_FORMAT.price(1200)).toBe("$1,200");
	});

	it("formats USD figures with German separators and symbol placement", () => {
		const de = pricingFormat("de");
		expect(plain(de.usdRate(0.025))).toBe("0,025 $");
		expect(plain(de.usd(0.1, 2))).toBe("0,10 $");
		expect(de.count(10_000)).toBe("10.000");
		expect(plain(de.bps(2650))).toBe("26,5 %");
		expect(plain(de.price(1200))).toBe("1.200 $");
	});

	it("renders a product row's figures in German", () => {
		const box = getStandaloneProductPricing("box", literalIn("de"), "de");
		expect(box).toBeDefined();
		const price = plain(box?.price ?? "");
		expect(price).toContain("0,025 $");
		expect(price).not.toContain("$0.025");
		const notify = plain(
			getStandaloneProductPricing("notify", literalIn("de"), "de")?.price ?? ""
		);
		expect(notify).toContain("10.000");
	});

	it("formats Japanese counts and prices", () => {
		const ja = pricingFormat("ja");
		expect(ja.count(100_000)).toBe("100,000");
		expect(ja.usd(0.1, 2)).toBe("$0.10");
	});

	it("formats the comparison table's prices and counts per locale", () => {
		const sections = comparisonSections(
			{ audience: "individual" },
			literalIn("de"),
			"de"
		);
		const rows = sections.flatMap((section) => section.rows);
		const price = rows.find((row) => row.id === "price");
		const emails = rows.find((row) => row.id === "monthly-emails");
		expect(plain(String(price?.values.pro))).toMatch(/^\d+ \$\/mo$/u);
		expect(String(emails?.values.max)).toBe("100.000");
	});
});
