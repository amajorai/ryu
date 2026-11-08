import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type ChartConfig,
	ChartContainer,
	ChartLegendContent,
	ChartTooltipContent,
} from "./chart";
import { DirectionProvider } from "./direction.tsx";

const config: ChartConfig = { cost: { label: "Cost", color: "#2563eb" } };

function chartWrapperTag(html: string): string {
	const match = html.match(/<div[^>]*data-slot="chart"[^>]*>/);
	if (!match) {
		throw new Error("chart wrapper not rendered");
	}
	return match[0];
}

test("ChartContainer keeps axes left to right under an RTL root", () => {
	const html = renderToStaticMarkup(
		<div dir="rtl" lang="ar">
			<ChartContainer config={config}>
				<svg aria-hidden="true" />
			</ChartContainer>
		</div>
	);

	expect(chartWrapperTag(html)).toContain('dir="ltr"');
});

test("ChartContainer lets a caller override the direction", () => {
	const html = renderToStaticMarkup(
		<ChartContainer config={config} dir="rtl">
			<svg aria-hidden="true" />
		</ChartContainer>
	);

	const tag = chartWrapperTag(html);
	expect(tag).toContain('dir="rtl"');
	expect(tag).not.toContain('dir="ltr"');
});

test("ChartTooltipContent resolves its own direction from its text", () => {
	const html = renderToStaticMarkup(
		<ChartContainer config={config}>
			<ChartTooltipContent
				active
				label="Monday"
				payload={[
					{
						dataKey: "cost",
						graphicalItemId: "cost",
						name: "cost",
						value: 12,
						color: "#2563eb",
						payload: { cost: 12 },
					},
				]}
			/>
		</ChartContainer>
	);

	expect(html).toContain("Monday");
	expect(html).toContain('dir="auto"');
});

const legendPayload = [
	{ color: "#2563eb", dataKey: "cost", type: "square" as const, value: "cost" },
];

function legendRootTag(html: string): string {
	const match = html.match(
		/<div[^>]*class="[^"]*justify-center gap-4[^"]*"[^>]*>/
	);
	if (!match) {
		throw new Error("legend root not rendered");
	}
	return match[0];
}

test("ChartLegendContent follows the UI direction under an RTL root", () => {
	const html = renderToStaticMarkup(
		<DirectionProvider direction="rtl">
			<ChartContainer config={config}>
				<ChartLegendContent payload={legendPayload} />
			</ChartContainer>
		</DirectionProvider>
	);

	expect(chartWrapperTag(html)).toContain('dir="ltr"');
	const legend = legendRootTag(html);
	expect(legend).toContain('dir="rtl"');
	expect(html).toContain("Cost");
});

test("ChartLegendContent stays left to right in an LTR UI", () => {
	const html = renderToStaticMarkup(
		<ChartContainer config={config}>
			<ChartLegendContent payload={legendPayload} />
		</ChartContainer>
	);

	expect(legendRootTag(html)).toContain('dir="ltr"');
});
