import { afterEach, describe, expect, test } from "bun:test";
import {
	type MarketplaceKind,
	searchMarketplaceCatalog,
} from "./marketplace.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockFetch(handler: (input: URL | RequestInfo) => Promise<Response>) {
	globalThis.fetch = handler as typeof fetch;
}

function card(kind: MarketplaceKind, id: string, name: string) {
	return {
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

		expect(requestedKinds).toHaveLength(14);
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
