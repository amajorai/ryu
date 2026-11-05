import { afterEach, describe, expect, test } from "bun:test";
import {
	formatMessage,
	I18nRuntime,
	messageIdForLiteral,
	registerLiteralCatalogLoader,
} from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { getProduct, products } from "../data/products.tsx";
import {
	STANDALONE_PRODUCT_PRICING,
	standaloneProductPricing,
} from "../data/standalone-pricing.ts";
import { productsIndexGroups } from "../products-index/products-index-data.ts";
import { productBaseFacts } from "./base-facts.ts";

// The one-line pricing fact (the /products index and each product's At a
// glance sheet) must be a whole catalog message. A sentence cut out of a
// longer message matches no catalog key, so it stayed English in every locale.

const LEAD_PRODUCTS = ["gateway", "box", "mail"] as const;

const DE: Record<string, string> = {
	"Self-hosting is free.": "Selbst hosten ist kostenlos.",
	"Ryu capacity, per running hour: small {boxSmallHour}, default {boxDefaultHour}, large {boxLargeHour}, billed per minute with a {minimumMinutes}-minute minimum per start.":
		"Ryu-Kapazität pro Laufstunde: klein {boxSmallHour}, Standard {boxDefaultHour}, groß {boxLargeHour}, minutengenau abgerechnet mit mindestens {minimumMinutes} Minuten pro Start.",
	"Free baseline: {inboxes} inbox, {emails} emails per month, and {storageGib} GiB of stored mail, once per person; emails are counted per recipient.":
		"Kostenlose Grundausstattung: {inboxes} Postfach, {emails} E-Mails pro Monat und {storageGib} GiB gespeicherte Mail, einmal pro Person; E-Mails werden pro Empfänger gezählt.",
};

const deTl: LiteralMessage = (source, values = {}) =>
	formatMessage(DE[source] ?? source, values, "de");

/** Every English message the pricing rows send through `tl`, as rendered. */
function renderedCatalogMessages(): Set<string> {
	const rendered = new Set<string>();
	const recordingTl: LiteralMessage = (source, values = {}) => {
		const text = formatMessage(source, values, "en");
		rendered.add(text);
		return text;
	};
	standaloneProductPricing(recordingTl);
	return rendered;
}

function product(slug: string) {
	const found = getProduct(slug);
	if (!found) {
		throw new Error(`unknown product ${slug}`);
	}
	return found;
}

function isMultiSentence(text: string): boolean {
	return /[.!?]\s+\S/.test(text);
}

describe("standalone price leads", () => {
	test("every price longer than one sentence defines its own lead", () => {
		const missing = STANDALONE_PRODUCT_PRICING.filter(
			(entry) => isMultiSentence(entry.price) && !entry.lead
		).map((entry) => entry.slug);
		expect(missing).toEqual([]);
	});

	test("each lead is the price's opening sentence, from the same figures", () => {
		for (const entry of STANDALONE_PRODUCT_PRICING) {
			if (!entry.lead) {
				continue;
			}
			expect(isMultiSentence(entry.lead)).toBe(false);
			expect(entry.price.startsWith(entry.lead)).toBe(true);
		}
		const leadSlugs = STANDALONE_PRODUCT_PRICING.filter((entry) => entry.lead)
			.map((entry) => entry.slug)
			.filter((slug) => slug !== "hire");
		expect(leadSlugs).toEqual([...LEAD_PRODUCTS]);
	});
});

describe("pricing facts are whole catalog messages", () => {
	test("the /products index prints only whole pricing messages", () => {
		const catalog = renderedCatalogMessages();
		const priced = productsIndexGroups()
			.flatMap((group) => group.rows)
			.filter((row) => row.pricing);
		expect(priced.length).toBeGreaterThan(0);
		for (const row of priced) {
			expect(catalog.has(row.pricing ?? "")).toBe(true);
		}
		for (const slug of LEAD_PRODUCTS) {
			expect(priced.some((row) => row.slug === slug)).toBe(true);
		}
	});

	test("every product's At a glance pricing fact is a whole message", () => {
		const catalog = renderedCatalogMessages();
		for (const entry of products) {
			const pricing = productBaseFacts(entry).find(
				(fact) => fact.label === "Pricing"
			);
			if (pricing) {
				expect(catalog.has(pricing.value)).toBe(true);
			}
		}
	});

	test("under de, Gateway, Box and Mail pricing facts carry no English", () => {
		const expected: Record<(typeof LEAD_PRODUCTS)[number], string> = {
			gateway: "Selbst hosten ist kostenlos.",
			box: "Ryu-Kapazität pro Laufstunde",
			mail: "Kostenlose Grundausstattung",
		};
		for (const slug of LEAD_PRODUCTS) {
			const pricing = productBaseFacts(product(slug), deTl, "de").find(
				(fact) => fact.label === "Pricing"
			);
			expect(pricing?.value.startsWith(expected[slug])).toBe(true);
			expect(pricing?.value).not.toMatch(
				/Self-hosting|capacity|running hour|Free baseline|per recipient/
			);
		}
	});

	test("under de, Box figures use the German number format", () => {
		const pricing = productBaseFacts(product("box"), deTl, "de").find(
			(fact) => fact.label === "Pricing"
		);
		expect(pricing?.value).toMatch(/\d,\d/);
		expect(pricing?.value).not.toMatch(/\$\d+\.\d/);
	});
});

describe("server-rendered pricing facts reach the DOM localizer whole", () => {
	afterEach(() => {
		registerLiteralCatalogLoader(null);
	});

	// The /products index and At a glance sheet render English; the DOM
	// localizer then looks each text node up (whole, or as a catalog template
	// with its figures as values). Mark every catalog lead per locale.
	for (const locale of ["ja", "ar"] as const) {
		test(`under ${locale}, the English facts match their catalog leads`, () => {
			const marker = `[${locale}]`;
			const catalog = Object.fromEntries(
				Object.keys(DE).map((source) => [source, `${marker} ${source}`])
			);
			registerLiteralCatalogLoader((requested) =>
				requested.startsWith(locale) ? catalog : null
			);
			const runtime = new I18nRuntime([], {
				initialLocale: locale,
				initialPackId: null,
			});
			const rows = productsIndexGroups().flatMap((group) => group.rows);
			for (const slug of LEAD_PRODUCTS) {
				const fact = productBaseFacts(product(slug)).find(
					(row) => row.label === "Pricing"
				)?.value;
				expect(rows.find((row) => row.slug === slug)?.pricing).toBe(fact);
				const text = fact ?? "";
				const localized = runtime.translate(
					messageIdForLiteral(text),
					{},
					text
				);
				expect(localized.startsWith(marker)).toBe(true);
			}
		});
	}
});
