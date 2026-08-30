// packages/core-client/src/client.test.ts
//
// Tests for the shared HTTP plumbing: apiUrl slash-joining, makeHeaders (bearer +
// injected surface token), buyerTokenHeader, and request (JSON parse, empty-body →
// undefined, non-2xx → structured ApiError). The provider setters are
// module-global, so each test resets them to avoid leaking a surface into others.

import { afterEach, describe, expect, test } from "bun:test";
import {
	ApiError,
	type ApiTarget,
	apiUrl,
	buyerTokenHeader,
	makeHeaders,
	request,
	SURFACE_HEADER,
	setBuyerTokenProvider,
	setSurfaceProvider,
	setUserJwtProvider,
	USER_JWT_HEADER,
} from "./client.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	// Reset module-global providers so tests don't leak into one another.
	setSurfaceProvider(() => null);
	setBuyerTokenProvider(() => null);
	setUserJwtProvider(() => null);
});

const target = (over?: Partial<ApiTarget>): ApiTarget => ({
	url: "http://127.0.0.1:7980",
	token: null,
	...over,
	userJwt: null,
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

	test("attaches a rotating user JWT separately from the node bearer", () => {
		let jwt = "alice-jwt";
		setUserJwtProvider(() => jwt);
		expect(makeHeaders("node-token")).toMatchObject({
			Authorization: "Bearer node-token",
			[USER_JWT_HEADER]: "alice-jwt",
		});
		jwt = "rotated-jwt";
		expect(makeHeaders("node-token")[USER_JWT_HEADER]).toBe("rotated-jwt");
	});

	test("uses a managed user JWT as the bearer when no node token exists", () => {
		expect(makeHeaders(null, "managed-user-jwt")).toMatchObject({
			Authorization: "Bearer managed-user-jwt",
			[USER_JWT_HEADER]: "managed-user-jwt",
		});
	});

	test("does not use the rotating identity provider as a remote node bearer", () => {
		setUserJwtProvider(() => "identity-only-jwt");
		expect(makeHeaders(null)).toEqual({
			"Content-Type": "application/json",
			[USER_JWT_HEADER]: "identity-only-jwt",
		});
	});
});

describe("buyerTokenHeader", () => {
	test("returns the header only when a control-plane token is present", () => {
		expect(buyerTokenHeader(target())).toEqual({});
		setBuyerTokenProvider(() => "sess");
		expect(buyerTokenHeader(target())).toEqual({ "X-Ryu-Buyer-Token": "sess" });
		expect(
			buyerTokenHeader(target({ url: "https://core.example.test" }))
		).toEqual({});
		expect(
			buyerTokenHeader(target({ url: "http://127.0.0.1.evil.test:7980" }))
		).toEqual({});
		expect(buyerTokenHeader(target({ url: "http://[::1]:7980" }))).toEqual({
			"X-Ryu-Buyer-Token": "sess",
		});
		expect(buyerTokenHeader(target({ url: "http://127.0.0.2:7980" }))).toEqual({
			"X-Ryu-Buyer-Token": "sess",
		});
	});
});

describe("request", () => {
	test("defaults to GET, parses JSON, and merges extra headers", async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = ((_url: string, init: RequestInit) => {
			capturedInit = init;
			return Promise.resolve(new Response('{"v":1}', { status: 200 }));
		}) as unknown as typeof fetch;
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

	test("keeps provider identity out of Authorization for an unbound target", async () => {
		let capturedInit: RequestInit | undefined;
		setUserJwtProvider(() => "identity-only-jwt");
		globalThis.fetch = ((_url: string, init: RequestInit) => {
			capturedInit = init;
			return Promise.resolve(new Response("{}", { status: 200 }));
		}) as unknown as typeof fetch;

		await request(target(), "/api/x");
		const h = capturedInit?.headers as Record<string, string>;
		expect(h.Authorization).toBeUndefined();
		expect(h[USER_JWT_HEADER]).toBe("identity-only-jwt");
	});

	test("serializes a body and honors the method", async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = ((_url: string, init: RequestInit) => {
			capturedInit = init;
			return Promise.resolve(new Response("{}", { status: 200 }));
		}) as unknown as typeof fetch;
		await request(target(), "/api/x", { method: "POST", body: { a: 1 } });
		expect(capturedInit?.method).toBe("POST");
		expect(capturedInit?.body).toBe('{"a":1}');
	});

	test("leaves body undefined when none is given", async () => {
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = ((_url: string, init: RequestInit) => {
			capturedInit = init;
			return Promise.resolve(new Response("{}", { status: 200 }));
		}) as unknown as typeof fetch;
		await request(target(), "/api/x");
		expect(capturedInit?.body).toBeUndefined();
	});

	test("returns undefined for an empty response body", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(
				new Response("", { status: 204 })
			)) as unknown as typeof fetch;
		expect(await request(target(), "/api/x")).toBeUndefined();
	});

	test("throws with path and status (no body) on non-2xx", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(
				new Response("ignored body", { status: 404 })
			)) as unknown as typeof fetch;
		await expect(request(target(), "/api/x")).rejects.toThrow(
			"/api/x failed: 404"
		);
	});

	test("exposes status and a structured server error without changing message", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(
				new Response('{"error":"skill_targets_required"}', { status: 409 })
			)) as unknown as typeof fetch;

		try {
			await request(target(), "/api/skills/catalog/install");
			expect.unreachable("request should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			if (!(error instanceof ApiError)) {
				return;
			}
			expect(error.message).toBe("/api/skills/catalog/install failed: 409");
			expect(error.status).toBe(409);
			expect(error.serverMessage).toBe("skill_targets_required");
		}
	});

	test("keeps non-JSON error bodies status-only", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(
				new Response("not json", { status: 502 })
			)) as unknown as typeof fetch;

		try {
			await request(target(), "/api/x");
			expect.unreachable("request should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			if (!(error instanceof ApiError)) {
				return;
			}
			expect(error.status).toBe(502);
			expect(error.serverMessage).toBeUndefined();
		}
	});
});
