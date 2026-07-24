// Unit tests for the launch update-check reader (core/update.ts). It issues one
// GET /api/update/check and maps the snake_case wire shape to a trimmed
// UpdateNotice, resolving null on ANY failure (non-2xx, thrown fetch, timeout) so a
// startup notice can never block or crash the shell. Global fetch is stubbed and
// restored per test — the same seam cli.api.test.ts uses — so nothing touches the
// network.

import { afterEach, expect, test } from "bun:test";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { fetchUpdateCheck } from "../core/update.ts";

const target: ApiTarget = { url: "http://node:7980", token: "node-secret" };
const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubFetch(impl: () => Promise<Response> | Response): string[] {
	const calls: string[] = [];
	globalThis.fetch = ((input: RequestInfo | URL) => {
		calls.push(String(input));
		return Promise.resolve(impl());
	}) as typeof fetch;
	return calls;
}

test("maps the wire shape (snake_case) to a trimmed UpdateNotice", async () => {
	const calls = stubFetch(
		() =>
			new Response(
				JSON.stringify({
					current: "0.0.7",
					latest: "0.0.8",
					update_available: true,
					html_url: "https://example.test/release",
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			)
	);
	const notice = await fetchUpdateCheck(target);
	expect(notice).toEqual({
		current: "0.0.7",
		latest: "0.0.8",
		available: true,
		htmlUrl: "https://example.test/release",
	});
	// Reads the update-check endpoint on the target node.
	expect(calls[0]).toContain("/api/update/check");
});

test("defaults every field when the wire payload is empty", async () => {
	stubFetch(
		() =>
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			})
	);
	const notice = await fetchUpdateCheck(target);
	expect(notice).toEqual({
		current: "",
		latest: "",
		available: false,
		htmlUrl: null,
	});
});

test("returns null on a non-2xx response (never throws)", async () => {
	stubFetch(() => new Response("nope", { status: 503 }));
	expect(await fetchUpdateCheck(target)).toBeNull();
});

test("returns null when fetch itself rejects (Core down / no network)", async () => {
	globalThis.fetch = (() =>
		Promise.reject(new Error("connection refused"))) as unknown as typeof fetch;
	expect(await fetchUpdateCheck(target)).toBeNull();
});

test("returns null when the body is not valid JSON", async () => {
	stubFetch(() => new Response("<html>not json</html>", { status: 200 }));
	expect(await fetchUpdateCheck(target)).toBeNull();
});

test("sends the bearer token when the target carries one", async () => {
	const seenAuth: (string | null)[] = [];
	globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		seenAuth.push(headers.get("authorization"));
		return Promise.resolve(new Response("{}", { status: 200 }));
	}) as unknown as typeof fetch;
	await fetchUpdateCheck(target);
	expect(seenAuth[0]).toBe("Bearer node-secret");
});
