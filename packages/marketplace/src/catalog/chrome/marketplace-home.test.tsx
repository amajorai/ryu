import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { NormalizedRecommendations } from "../recommendations.ts";
import MarketplaceHome from "./marketplace-home.tsx";

const EMPTY_RECOMMENDATIONS: NormalizedRecommendations = {
	cadence: "weekly",
	enabled: false,
	hidden: false,
	items: [],
};

const ENABLED_RECOMMENDATIONS: NormalizedRecommendations = {
	cadence: "weekly",
	enabled: true,
	hidden: false,
	items: [
		{
			description: "A safe cross-kind match",
			iconUrl: null,
			id: "mcp/recommended",
			installed: false,
			kind: "mcp",
			name: "Recommended MCP",
			reason: "Matches your catalog",
		},
	],
};

describe("MarketplaceHome", () => {
	test("keeps the shared shelf order and teaser cap across hosts", () => {
		const html = renderToStaticMarkup(
			<MarketplaceHome
				recommendations={{ data: EMPTY_RECOMMENDATIONS }}
				shelves={[
					{
						items: Array.from({ length: 7 }, (_, index) => ({
							id: `model-${index + 1}`,
							name: `Model ${index + 1}`,
						})),
						key: "models",
					},
				]}
			/>
		);

		expect(html.indexOf("Popular models")).toBeLessThan(
			html.indexOf("Featured skills")
		);
		expect(
			(html.match(/data-slot="marketplace-home-shelf"/g) ?? []).length
		).toBe(6);
		expect(html).toContain("Model 6");
		expect(html).not.toContain("Model 7");
	});

	test("keeps every canonical shelf mounted when a feed is empty", () => {
		const html = renderToStaticMarkup(
			<MarketplaceHome
				recommendations={{ data: EMPTY_RECOMMENDATIONS }}
				shelves={[{ items: [], key: "models", loading: false }]}
			/>
		);

		expect(html).toContain("Popular models");
		expect(html).toContain("No models found.");
		expect(html).toContain("Plugins");
	});

	test("renders For you once above the canonical shelves", () => {
		const html = renderToStaticMarkup(
			<MarketplaceHome
				recommendations={{ data: ENABLED_RECOMMENDATIONS }}
				shelves={[{ items: [], key: "models", loading: false }]}
			/>
		);

		expect(html.indexOf("For you")).toBeLessThan(
			html.indexOf("Popular models")
		);
		expect((html.match(/>For you</g) ?? []).length).toBe(1);
		expect(html).not.toContain("No featured listings yet.");
	});

	test("allows a host to name a different source without changing shelf order", () => {
		const html = renderToStaticMarkup(
			<MarketplaceHome
				recommendations={{ data: EMPTY_RECOMMENDATIONS }}
				shelves={[
					{
						emptyLabel: "No agent templates found.",
						items: [],
						key: "agents",
						title: "Agent Templates",
					},
				]}
			/>
		);

		expect(html).toContain("Agent Templates");
		expect(html).toContain("No agent templates found.");
		expect(html).not.toContain(">No agents found.<");
	});
});
