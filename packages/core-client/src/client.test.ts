// packages/core-client/src/client.test.ts
//
// Tests for the shared HTTP plumbing: apiUrl slash-joining, makeHeaders (bearer +
// injected surface token), buyerTokenHeader, and request (JSON parse, empty-body →
// undefined, non-2xx → Error carrying only the status). The provider setters are
// module-global, so each test resets them to avoid leaking a surface into others.

import { afterEach, describe, expect, test } from "bun:test";
import {
	type ApiTarget,
	apiUrl,
	buyerTokenHeader,
	makeHeaders,
	request,
	SURFACE_HEADER,
	setBuyerTokenProvider,
	setSurfaceProvider,
} from "./client.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	// Reset module-global providers so tests don't leak into one another.
	setSurfaceProvider(() => null);
	setBuyerTokenProvider(() => null);
});

const target = (over?: Partial<ApiTarget>): ApiTarget => ({
	url: "http://127.0.0.1:7980",
	token: null,
	...over,
});

describe("apiUrl", () => {
	test("joins without doubling the slash", () => {
		expect(apiUrl(target(), "/api/x")).toBe("http://127.0.0.1:7980/api/x");
		expect(apiUrl(target({ url: "http://h/" }), "/api/x")).toBe(
			"http://h/api/x"
		);
	});

	test("prefixes a slash when the path lacks one", () => {
		expect(apiUrl(target(), "api/x")).toBe("http://127.0.0.1:7980/api/x");
	});
});

describe("makeHeaders", () => {
	test("sets JSON content-type, and a bearer only when token present", () => {
		expect(makeHeaders(null)).toEqual({ "Content-Type": "application/json" });
		expect(makeHeaders("t").Authorization).toBe("Bearer t");
	});

	test("attaches the surface header from the injected provider", () => {
		setSurfaceProvider(() => "mobile");
		expect(makeHeaders("t")[SURFACE_HEADER]).toBe("mobile");
	});

	test("omits the surface header when the provider returns null", () => {
		setSurfaceProvider(() => null);
		expect(makeHeaders("t")[SURFACE_HEADER]).toBeUndefined();
	});
});

describe("buyerTokenHeader", () => {
	test("returns the header only when a control-plane token is present", () => {
		expect(buyerTokenHeader()).toEqual({});
		setBuyerTokenProvider(() => "sess");
		expect(buyerTokenHeader()).toEqual({ "X-Ryu-Buyer-Token": "sess" });
	});
});

describe("request", () => {
	test("defaults to GET, parses JSON, and merges extra headers", async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = ((_url: string, init: RequestInit) => {
			capturedInit = init;
			return Promise.resolve(new Response('{"v":1}', { status: 200 }));
		}) as typeof fetch;
		const data = await request<{ v: number }>(
			target({ token: "t" }),
			"/api/x",
			{
				headers: { "X-Extra": "1" },
			}
		);
		expect(data).toEqual({ v: 1 });
		expect(capturedInit?.method).toBe("GET");
		const h = capturedInit?.headers as Record<string, string>;
		expect(h.Authorization).toBe("Bearer t");
		expect(h["X-Extra"]).toBe("1");
	});

	test("serializes a body and honors the method", async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = ((_url: string, init: RequestInit) => {
			capturedInit = init;
			return Promise.resolve(new Response("{}", { status: 200 }));
		}) as typeof fetch;
		await request(target(), "/api/x", { method: "POST", body: { a: 1 } });
		expect(capturedInit?.method).toBe("POST");
		expect(capturedInit?.body).toBe('{"a":1}');
	});

	test("leaves body undefined when none is given", async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = ((_url: string, init: RequestInit) => {
			capturedInit = init;
			return Promise.resolve(new Response("{}", { status: 200 }));
		}) as typeof fetch;
		await request(target(), "/api/x");
		expect(capturedInit?.body).toBeUndefined();
	});

	test("returns undefined for an empty response body", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(new Response("", { status: 204 }))) as typeof fetch;
		expect(await request(target(), "/api/x")).toBeUndefined();
	});

	test("throws with path and status (no body) on non-2xx", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(
				new Response("ignored body", { status: 404 })
			)) as typeof fetch;
		await expect(request(target(), "/api/x")).rejects.toThrow(
			"/api/x failed: 404"
		);
	});
});
