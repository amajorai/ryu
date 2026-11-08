import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act } from "react";

import { registerTestDom } from "./test-dom-env.ts";

await registerTestDom();
const { loadReactDomClient } = await import("./test-dom-env.ts");
const { createRoot } = await loadReactDomClient();
const { I18nProvider } = await import("./react.tsx");
const { registerLiteralCatalogLoader } = await import("./literal-catalog.ts");

/** Locales that group thousands with `.`, as `formatCount` renders them. */
const DOT_GROUPING_LOCALES = ["de", "es", "it", "pt-BR"] as const;
const TOKENS = "{count} tokens";

const catalogs = new Map<string, Record<string, string>>();

/** The shipped catalog for `locale` (`packages/i18n/locales/<locale>.json`). */
function officialCatalog(locale: string): Record<string, string> {
	let catalog = catalogs.get(locale);
	if (!catalog) {
		const url = new URL(`../locales/${locale}.json`, import.meta.url);
		catalog = JSON.parse(readFileSync(url, "utf8")) as Record<string, string>;
		catalogs.set(locale, catalog);
	}
	return catalog;
}

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

/** `texts` rendered under a real provider that localizes the DOM on mount. */
async function renderLocalized(
	locale: string,
	texts: readonly string[]
): Promise<string[]> {
	registerLiteralCatalogLoader((requested) =>
		requested === locale ? officialCatalog(locale) : null
	);
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	await act(() => {
		root.render(
			<I18nProvider
				autoLocalizeDom="immediate"
				initialLocale={locale}
				initialPackId={null}
			>
				{texts.map((text) => (
					<span key={text}>{text}</span>
				))}
			</I18nProvider>
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	const rendered = [...mount.querySelectorAll("span")].map(
		(span) => span.textContent ?? ""
	);
	await act(async () => root.unmount());
	return rendered;
}

/** Building a template index over a full shipped catalog takes a few seconds. */
const OFFICIAL_CATALOG_TIMEOUT_MS = 60_000;

test.each(DOT_GROUPING_LOCALES)(
	"a locale-grouped token count keeps its value in the %s DOM",
	async (locale) => {
		const translation = officialCatalog(locale)[TOKENS];
		expect(translation).toContain("{count}");
		const grouped = [32_768, 131_072].map((value) =>
			new Intl.NumberFormat(locale).format(value)
		);
		for (const value of grouped) {
			expect(value).toContain(".");
		}
		expect(
			await renderLocalized(
				locale,
				grouped.map((value) => `${value} tokens`)
			)
		).toEqual(
			grouped.map((value) => (translation ?? TOKENS).replace("{count}", value))
		);
	},
	OFFICIAL_CATALOG_TIMEOUT_MS
);
