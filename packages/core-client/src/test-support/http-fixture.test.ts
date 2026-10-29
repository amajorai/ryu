import { expect, test } from "bun:test";
import { createFetchFixture, parseJsonRequestBody } from "./http-fixture.ts";

test("fetch fixtures preserve the request URL and options for all Fetch input forms", async () => {
	const calls: { url: string; init: RequestInit }[] = [];
	const fixture = createFetchFixture(async (url, init) => {
		calls.push({ url, init });
		return Response.json({ ok: true });
	});
	const init: RequestInit = { method: "POST", body: '{"value":1}' };
	for (const input of [
		"https://example.test/a",
		new URL("https://example.test/a"),
		new Request("https://example.test/a"),
	]) {
		await fixture(input, init);
	}
	expect(calls).toEqual(
		Array.from({ length: 3 }, () => ({ url: "https://example.test/a", init }))
	);
	expect(calls.every((call) => call.init === init)).toBe(true);
});

test("captured JSON request parsing rejects a missing or non-string body", () => {
	expect(parseJsonRequestBody('{"event":"test"}')).toEqual({ event: "test" });
	expect(() => parseJsonRequestBody(undefined)).toThrow();
	expect(() => parseJsonRequestBody(new Blob(['{"event":"test"}']))).toThrow();
});
