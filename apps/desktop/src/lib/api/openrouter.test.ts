import { describe, expect, it } from "bun:test";
import { parseOpenRouterProviders } from "./openrouter.ts";

describe("parseOpenRouterProviders", () => {
	it("keeps valid provider slugs, applies name fallbacks, and sorts labels", () => {
		expect(
			parseOpenRouterProviders({
				data: [
					{ name: "Vertex AI", slug: "google-vertex" },
					{ slug: "azure" },
					{ name: "", slug: "anthropic" },
					{ name: "Missing slug" },
					null,
				],
			})
		).toEqual([
			{ name: "anthropic", slug: "anthropic" },
			{ name: "azure", slug: "azure" },
			{ name: "Vertex AI", slug: "google-vertex" },
		]);
	});

	it("rejects malformed or empty catalogs so the UI can use custom slugs", () => {
		expect(() => parseOpenRouterProviders({ providers: [] })).toThrow(
			/unexpected provider catalog/
		);
		expect(() =>
			parseOpenRouterProviders({ data: [null, { slug: " " }] })
		).toThrow(/no usable providers/);
	});
});
