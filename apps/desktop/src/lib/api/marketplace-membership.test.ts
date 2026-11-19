import { afterEach, expect, test } from "bun:test";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import { MarketplaceError } from "./marketplace-http.ts";
import { fetchMarketplaceMembershipPublisherReport } from "./marketplace-membership.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function serve(body: object, status = 200): string[] {
	const urls: string[] = [];
	globalThis.fetch = createFetchFixture(originalFetch, (input) => {
		urls.push(String(input));
		return Promise.resolve(Response.json(body, { status }));
	});
	return urls;
}

test("defaults an empty publisher report instead of guessing totals", async () => {
	const urls = serve({});
	expect(await fetchMarketplaceMembershipPublisherReport()).toEqual({
		currencies: [],
		eligibleListingCount: 0,
		organizationId: "",
	});
	expect(
		urls[0]?.endsWith("/api/marketplace/membership/publisher-report")
	).toBe(true);
});

test("surfaces a signed-out publisher report as an auth error", async () => {
	serve({ error: "Sign in" }, 401);
	const error = await fetchMarketplaceMembershipPublisherReport().catch(
		(caught: unknown) => caught
	);
	expect(error).toBeInstanceOf(MarketplaceError);
	expect((error as MarketplaceError).kind).toBe("auth");
});
