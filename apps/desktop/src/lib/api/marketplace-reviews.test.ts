import { afterEach, expect, test } from "bun:test";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import { fetchReviews } from "./marketplace-reviews.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("sends the page cursor and defaults an empty reviews page", async () => {
	const urls: string[] = [];
	globalThis.fetch = createFetchFixture(originalFetch, (input) => {
		urls.push(String(input));
		return Promise.resolve(Response.json({}));
	});
	const page = await fetchReviews("plugin", "@ryu/crm", {
		cursor: "next-1",
		limit: 5,
	});
	expect(page).toEqual({
		nextCursor: null,
		ratingAverage: 0,
		ratingCount: 0,
		reviews: [],
	});
	const url = new URL(urls[0] ?? "");
	expect(url.pathname.endsWith("/api/marketplace/reviews")).toBe(true);
	expect(Object.fromEntries(url.searchParams)).toEqual({
		cursor: "next-1",
		id: "@ryu/crm",
		kind: "plugin",
		limit: "5",
	});
});
