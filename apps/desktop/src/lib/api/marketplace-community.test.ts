import { afterEach, expect, test } from "bun:test";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import { likeItem, unlikeItem } from "./marketplace-community.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function serve(body: object): { method: string; url: string }[] {
	const calls: { method: string; url: string }[] = [];
	globalThis.fetch = createFetchFixture(originalFetch, (input, init) => {
		calls.push({ method: init?.method ?? "GET", url: String(input) });
		return Promise.resolve(Response.json(body));
	});
	return calls;
}

test("normalizes a like snapshot and keeps the requested namespace", async () => {
	serve({ count: -3, liked: true });
	expect(await likeItem("@ryu/crm")).toEqual({
		count: 0,
		liked: true,
		namespace: "@ryu/crm",
	});
});

test("unlikes through the namespace query on DELETE", async () => {
	const calls = serve({ count: 4, liked: false, namespace: "owner/repo" });
	expect(await unlikeItem("owner/repo")).toEqual({
		count: 4,
		liked: false,
		namespace: "owner/repo",
	});
	expect(calls[0]?.method).toBe("DELETE");
	expect(new URL(calls[0]?.url ?? "").searchParams.get("namespace")).toBe(
		"owner/repo"
	);
});
