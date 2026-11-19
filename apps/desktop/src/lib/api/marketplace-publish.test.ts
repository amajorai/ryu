import { afterEach, expect, test } from "bun:test";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import { MarketplaceError } from "./marketplace-http.ts";
import { publishRunnable } from "./marketplace-publish.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function serve(body: object, status = 200): unknown[] {
	const sent: unknown[] = [];
	globalThis.fetch = createFetchFixture(originalFetch, (_input, init) => {
		sent.push(JSON.parse(String(init?.body)));
		return Promise.resolve(Response.json(body, { status }));
	});
	return sent;
}

test("forwards the publish body and fills a sparse response from it", async () => {
	const body = { id: "my-skill", kind: "skill" as const, name: "Mine" };
	const sent = serve({});
	expect(await publishRunnable(body)).toEqual({
		approved: [],
		id: "my-skill",
		kind: "skill",
		status: "pending",
	});
	expect(sent).toEqual([body]);
});

test("rejects a signed-out publish with an auth MarketplaceError", async () => {
	serve({}, 401);
	const error = await publishRunnable({
		id: "x",
		kind: "skill",
		name: "X",
	}).catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(MarketplaceError);
	expect((error as MarketplaceError).kind).toBe("auth");
});
