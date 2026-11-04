import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CommissionRule } from "../../utils/api-client.ts";
import { DefaultCommissionSection } from "./default-commission-section.tsx";

// The closed Type and Funded-by triggers must show the translated option
// label. A bare <SelectValue /> without `items` printed the raw value
// ("percent", "seller") in every locale.

function shippedCatalog(locale: string): Record<string, string> {
	const path = fileURLToPath(
		new URL(`../../../../i18n/locales/${locale}.json`, import.meta.url)
	);
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

const noop = () => undefined;

function render(locale: string, rule: CommissionRule): string {
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			initialPackId={null}
			manageDocument={false}
			overlays={{ [locale]: shippedCatalog(locale) }}
		>
			<DefaultCommissionSection
				editorOpen
				hasDefaultCommission
				onClear={noop}
				onSave={noop}
				onToggleEditor={noop}
				rule={rule}
				savePending={false}
				setRule={noop}
			/>
		</I18nProvider>
	);
}

/** The text of the closed trigger whose id is `id`. */
function triggerText(html: string, id: string): string {
	const start = html.indexOf(`id="${id}"`);
	if (start < 0) {
		throw new Error(`no trigger with id ${id}`);
	}
	const end = html.indexOf("</button>", start);
	return html.slice(start, end).replaceAll(/<[^>]*>/g, "");
}

const rule: CommissionRule = {
	durationMonths: null,
	fundedBy: "seller",
	recurring: false,
	type: "percent",
	value: 1000,
};

describe("DefaultCommissionSection select triggers", () => {
	test("show the German labels, not the raw values", () => {
		const de = shippedCatalog("de");
		const html = render("de", rule);
		const type = triggerText(html, "commission-type");
		const funded = triggerText(html, "commission-funded");
		expect(de.Percent).toBeTruthy();
		expect(type).toContain(de.Percent ?? "");
		expect(type).not.toContain("percent");
		expect(funded).toContain(de.Seller ?? "");
		expect(funded).not.toContain("seller");
	});

	for (const locale of ["ja", "ar"]) {
		test(`show the ${locale} labels, not the raw values`, () => {
			const catalog = shippedCatalog(locale);
			const html = render(locale, rule);
			const type = triggerText(html, "commission-type");
			const funded = triggerText(html, "commission-funded");
			expect(catalog.Percent).toBeTruthy();
			expect(catalog.Seller).toBeTruthy();
			expect(type).toContain(catalog.Percent ?? "");
			expect(type).not.toContain("percent");
			expect(funded).toContain(catalog.Seller ?? "");
			expect(funded).not.toContain("seller");
		});
	}

	test("show the English labels in English", () => {
		const html = render("en", { ...rule, fundedBy: "platform", type: "flat" });
		expect(triggerText(html, "commission-type")).toContain("Flat");
		expect(triggerText(html, "commission-funded")).toContain("Platform");
	});
});
