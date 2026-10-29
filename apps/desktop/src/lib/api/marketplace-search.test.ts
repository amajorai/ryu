import { afterEach, describe, expect, test } from "bun:test";
import {
	fetchCatalogPage,
	type MarketplaceKind,
	searchMarketplaceCatalog,
} from "./marketplace.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockFetch(handler: (input: URL | RequestInfo) => Promise<Response>) {
	globalThis.fetch = Object.assign(handler, {
		preconnect: originalFetch.preconnect,
	});
}

function card(kind: MarketplaceKind, id: string, name: string) {
	return {
		author: null,
		category: null,
		description: null,
		iconUrl: null,
		installSource: null,
		pricing: null,
		ratingAverage: 0,
		ratingCount: 0,
		version: "1.0.0",
		firstParty: kind === "app",
		id,
		kind,
		name,
	};
}

describe("searchMarketplaceCatalog", () => {
	test("fans out across Marketplace kinds and de-duplicates results", async () => {
		const requestedKinds: string[] = [];
		mockFetch(async (input) => {
			const kind = new URL(String(input)).searchParams.get("kind") ?? "";
			requestedKinds.push(kind);
			return new Response(
				JSON.stringify({
					items:
						kind === "app"
							? [
									card("app", "com.example.app", "Example App"),
									card("app", "com.example.app", "Example App"),
								]
							: [],
				}),
				{ headers: { "Content-Type": "application/json" }, status: 200 }
			);
		});

		const results = await searchMarketplaceCatalog("example", 8);

		expect(requestedKinds).toHaveLength(15);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			id: "com.example.app",
			kind: "app",
			name: "Example App",
		});
	});

	test("ignores an unavailable kind without failing the palette search", async () => {
		mockFetch(async (input) => {
			const kind = new URL(String(input)).searchParams.get("kind");
			if (kind === "app") {
				return new Response(JSON.stringify({ error: "offline" }), {
					status: 503,
				});
			}
			return new Response(
				JSON.stringify({
					items: [card("skill", "skill.example", "Example Skill")],
				}),
				{ headers: { "Content-Type": "application/json" }, status: 200 }
			);
		});

		const results = await searchMarketplaceCatalog("example", 8);

		expect(results).toHaveLength(1);
		expect(results[0]?.kind).toBe("skill");
	});
});

describe("fetchCatalogPage", () => {
	test("forwards the cursor and a bounded limit, and returns the next cursor", async () => {
		const requested: URL[] = [];
		mockFetch(async (input) => {
			const url = new URL(String(input));
			requested.push(url);
			const cursor = url.searchParams.get("cursor");
			return new Response(
				JSON.stringify({
					items: [card("skill", `skill.${cursor ?? "first"}`, "Paged")],
					nextCursor: cursor ? null : "40",
				}),
				{ headers: { "Content-Type": "application/json" }, status: 200 }
			);
		});

		const first = await fetchCatalogPage("skill", " paged ", { limit: 500 });
		expect(first.items.map((item) => item.id)).toEqual(["skill.first"]);
		expect(first.nextCursor).toBe("40");

		const second = await fetchCatalogPage("skill", "paged", {
			cursor: first.nextCursor,
		});
		expect(second.items.map((item) => item.id)).toEqual(["skill.40"]);
		expect(second.nextCursor).toBeNull();

		expect(requested[0]?.searchParams.get("query")).toBe("paged");
		expect(requested[0]?.searchParams.get("limit")).toBe("100");
		expect(requested[0]?.searchParams.has("cursor")).toBe(false);
		expect(requested[1]?.searchParams.get("cursor")).toBe("40");
	});

	test("treats a server without paging as a single last page", async () => {
		mockFetch(
			async () =>
				new Response(
					JSON.stringify({ items: [card("app", "com.example.app", "App")] }),
					{ headers: { "Content-Type": "application/json" }, status: 200 }
				)
		);

		const page = await fetchCatalogPage("app");

		expect(page.items).toHaveLength(1);
		expect(page.nextCursor).toBeNull();
	});

	test("surfaces a rejected cursor as an error instead of restarting", async () => {
		mockFetch(
			async () =>
				new Response(
					JSON.stringify({
						error: "`cursor` must come from a previous `nextCursor`",
						items: [],
					}),
					{ headers: { "Content-Type": "application/json" }, status: 400 }
				)
		);

		await expect(
			fetchCatalogPage("skill", "", { cursor: "not-a-cursor" })
		).rejects.toThrow("nextCursor");
	});
});
