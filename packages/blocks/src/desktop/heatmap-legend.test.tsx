import { expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { useHeatmapLegendWords } from "./heatmap-legend.ts";

function Legend() {
	const { less, more } = useHeatmapLegendWords();
	return (
		<span>
			{less}|{more}
		</span>
	);
}

function render(locale: string): string {
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			manageDocument={false}
		>
			<Legend />
		</I18nProvider>
	);
}

test("the legend ends read through the heatmap senses", () => {
	expect(render("ja")).toBe("<span>少|多</span>");
});

test("English keeps Less and More", () => {
	expect(render("en")).toBe("<span>Less|More</span>");
});
