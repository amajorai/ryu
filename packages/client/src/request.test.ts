// packages/client/src/request.test.ts
//
// Tests for the internal HTTP helper: buildUrl (base-URL slash normalization),
// buildHeaders (bearer + content-type + extra merge), and request (JSON parse,
// empty-body → undefined, and non-2xx → Error carrying status + response body).

import { afterEach, describe, expect, test } from "bun:test";
import { buildHeaders, buildUrl, request } from "./request.ts";
import { installFetch } from "./test-fetch.ts";
import type { RyuClientOptions } from "./types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const opts = (over?: Partial<RyuClientOptions>): RyuClientOptions => ({
	baseUrl: "http://localhost:7980",
	...over,
});

describe("buildUrl", () => {
	test("joins base and path with a single slash", () => {
		expect(buildUrl(opts(), "/api/agents")).toBe(
			"http://localhost:7980/api/agents"
		);
	});

	test("strips trailing slashes from the base", () => {
		expect(buildUrl(opts({ baseUrl: "http://x:7980///" }), "/api/a")).toBe(
			"http://x:7980/api/a"
		);
	});

	test("inserts a slash when the path is not absolute", () => {
		expect(buildUrl(opts(), "api/a")).toBe("http://localhost:7980/api/a");
	});
});

describe("buildHeaders", () => {
	test("always sets a JSON content-type", () => {
		expect(buildHeaders(opts())["Content-Type"]).toBe("application/json");
	});

	test("adds a bearer token when present, omits when absent", () => {
		expect(buildHeaders(opts({ token: "t" })).Authorization).toBe("Bearer t");
		expect(buildHeaders(opts()).Authorization).toBeUndefined();
	});

	test("keeps the node bearer and rotating user JWT in distinct headers", () => {
		let jwt = "alice-jwt";
		const options = opts({ token: "node-token", userJwt: () => jwt });
		expect(buildHeaders(options)).toMatchObject({
			Authorization: "Bearer node-token",
			"x-ryu-user-jwt": "alice-jwt",
		});
		jwt = "rotated-jwt";
		expect(buildHeaders(options)["x-ryu-user-jwt"]).toBe("rotated-jwt");
	});

	test("merges and lets extra headers override defaults", () => {
		const h = buildHeaders(opts(), {
			"X-A": "1",
			"Content-Type": "text/plain",
		});
		expect(h["X-A"]).toBe("1");
		expect(h["Content-Type"]).toBe("text/plain");
	});
});

describe("request", () => {
	test("sends url + headers and parses a JSON response", async () => {
		let capturedUrl: string | undefined;
		let capturedInit: RequestInit | undefined;
		installFetch((input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			capturedUrl = url;
			capturedInit = init;
			return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
		});

		const data = await request<{ ok: boolean }>(opts({ token: "t" }), "/api/x");
		expect(data).toEqual({ ok: true });
		expect(capturedUrl).toBe("http://localhost:7980/api/x");
		expect(
			(capturedInit?.headers as Record<string, string>).Authorization
		).toBe("Bearer t");
	});

	test("returns undefined for an empty (no-content) body", async () => {
		installFetch(() => Promise.resolve(new Response("", { status: 204 })));
		expect(await request(opts(), "/api/x")).toBeUndefined();
	});

	test("throws with the path, status, and body text on non-2xx", async () => {
		installFetch(() => Promise.resolve(new Response("boom", { status: 500 })));
		await expect(request(opts(), "/api/x")).rejects.toThrow(
			"RyuClient: /api/x failed (500): boom"
		);
	});

	test("forwards method and body from init", async () => {
		let capturedInit: RequestInit | undefined;
		installFetch((input: RequestInfo | URL, init?: RequestInit) => {
			const _url = String(input);
			capturedInit = init;
			return Promise.resolve(new Response("{}", { status: 200 }));
		});
		await request(opts(), "/api/x", {
			method: "POST",
			body: JSON.stringify({ a: 1 }),
		});
		expect(capturedInit?.method).toBe("POST");
		expect(capturedInit?.body).toBe('{"a":1}');
	});

	test("uses an injected fetch implementation", async () => {
		let called = false;
		const fetchImpl: NonNullable<RyuClientOptions["fetch"]> = async () => {
			called = true;
			return new Response('{"ok":true}', { status: 200 });
		};
		const data = await request<{ ok: boolean }>(
			opts({ fetch: fetchImpl }),
			"/api/x"
		);
		expect(called).toBe(true);
		expect(data).toEqual({ ok: true });
	});
});
