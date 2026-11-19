import { expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComputeShareSurface } from "./ComputeShareSurface.tsx";

test("Compute keeps the live lease action unavailable until the provider network exists", () => {
	const markup = renderToStaticMarkup(<ComputeShareSurface mode="compute" />);

	expect(markup).toContain('data-testid="compute-surface"');
	expect(markup).toContain('data-exchange-state="preview"');
	expect(markup).toContain("Borrow a lane. Keep your node.");
	expect(markup).toContain("Provider network is not enabled.");
	expect(markup).toContain('disabled=""');
});

test("Share exposes both provider offer modes without claiming publication", () => {
	const markup = renderToStaticMarkup(<ComputeShareSurface mode="share" />);

	expect(markup).toContain('data-testid="share-surface"');
	expect(markup).toContain("Compute lane");
	expect(markup).toContain("Hosted agent");
	expect(markup).toContain("Provider enrollment is not enabled.");
	expect(markup).toContain("The host boundary");
});

test("Share names its schedule picker in the available-hours sense", () => {
	// The bare "Availability" is the product-page status (ja 提供状況); the
	// schedule picker keeps the hours the node is offered (ja 提供可能時間).
	const markup = renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale="ja"
			initialPackId="official/ja"
		>
			<ComputeShareSurface mode="share" />
		</I18nProvider>
	);

	expect(markup).toContain("提供可能時間");
	expect(markup).toContain('aria-label="提供可能時間"');
});
