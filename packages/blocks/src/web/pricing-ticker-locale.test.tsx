import { expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PriceBlock } from "./pricing-card-parts.tsx";
import { LifetimePlanCard } from "./pricing-license-cards.tsx";

// The animated price tickers place the currency symbol where the page language
// does ("20 $" in German), the same as the surrounding pricing copy.

function renderIn(locale: string, node: ReactNode): string {
	return renderToStaticMarkup(
		<I18nProvider initialLocale={locale} initialPackId={null}>
			{node}
		</I18nProvider>
	).replace(/ | /gu, " ");
}

function tickerLabels(html: string): string[] {
	return [...html.matchAll(/aria-label="([^"]*)"/gu)].map(
		(match) => match[1] ?? ""
	);
}

test("German price tickers put the dollar sign after the number", () => {
	const labels = tickerLabels(
		renderIn("de", <PriceBlock isYearly={false} monthly={20} />)
	);
	expect(labels).toContain("20 $");
	expect(labels.some((label) => label.startsWith("$"))).toBe(false);
});

test("English price tickers keep the dollar prefix", () => {
	const labels = tickerLabels(
		renderIn("en", <PriceBlock isYearly={false} monthly={20} />)
	);
	expect(labels).toContain("$20");
});

test("the license card's struck-through list price follows the locale", () => {
	const html = renderIn("de", <LifetimePlanCard />);
	expect(tickerLabels(html)).toContain("129 $");
	expect(html).toContain("200 $");
	expect(html).not.toContain("$200");
});
