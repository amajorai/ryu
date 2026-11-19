// The workflows scene's "Started" is a run step's status and reads through
// the keyed `runs.started` (ja 開始済み). The bare catalog "Started" is a
// start-time column (ja 開始日時).
import { expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductCatalogScene } from "./product-catalog-scenes.tsx";

function senseLabels(locale: string): string[] {
	const html = renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			initialPackId={locale === "en" ? null : `official/${locale}`}
			manageDocument={false}
		>
			<ProductCatalogScene id="workflows" />
		</I18nProvider>
	);
	return [...html.matchAll(/<span data-ryu-i18n="off">([^<]*)</g)].map(
		(match) => match[1] ?? ""
	);
}

test("the Japanese workflows scene marks the trigger 開始済み", () => {
	expect(senseLabels("ja")).toContain("開始済み");
});

test("English keeps Started", () => {
	expect(senseLabels("en")).toContain("Started");
});
