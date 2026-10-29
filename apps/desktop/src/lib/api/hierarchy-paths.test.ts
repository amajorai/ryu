import { expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	clearScopeDefault,
	setScopeDefault,
	setScopeGuidance,
} from "./hierarchy.ts";

test("scope default mutations stay within their authenticated route", async () => {
	const originalFetch = globalThis.fetch;
	const requests: Request[] = [];
	Reflect.set(
		globalThis,
		"fetch",
		(url: RequestInfo | URL, init?: RequestInit) => {
			requests.push(new Request(url, init));
			return Promise.resolve(Response.json({}));
		}
	);
	const target: ApiTarget = {
		url: "http://127.0.0.1:7980",
		token: "fixture-node-token",
		userJwt: "fixture-user-jwt",
	};
	const value = { provider: "fixture", model: "fixture-model", effort: "high" };
	try {
		for (const scope of [
			"agent:worker/../../conversations/victim/access",
			"agent:worker\\..\\..\\conversations\\victim\\access",
			"agent:%2e%2e/%2f?query=1#fragment",
			"global",
			"agent:acp:kiro",
			"agent:..",
			"project:project-1",
			"project:project-1/agent:acp:kiro",
		]) {
			requests.length = 0;
			await setScopeDefault(target, scope, value);
			await clearScopeDefault(target, scope);
			expect(requests).toHaveLength(2);
			for (const [index, request] of requests.entries()) {
				const url = new URL(request.url);
				expect(url.pathname).toBe(
					`/api/scope-defaults/${encodeURIComponent(scope)}`
				);
				expect(
					decodeURIComponent(url.pathname.slice("/api/scope-defaults/".length))
				).toBe(scope);
				expect(url.search).toBe("");
				expect(url.hash).toBe("");
				expect(request.method).toBe(index === 0 ? "PUT" : "DELETE");
				expect(request.headers.get("authorization")).toBe(
					"Bearer fixture-node-token"
				);
				expect(request.headers.get("x-ryu-user-jwt")).toBe("fixture-user-jwt");
				if (index === 0) {
					expect(await request.json()).toEqual(value);
				}
			}
		}
		requests.length = 0;
		for (const scope of [".", ".."]) {
			await expect(setScopeDefault(target, scope, value)).rejects.toThrow(
				"dot segment"
			);
			await expect(clearScopeDefault(target, scope)).rejects.toThrow(
				"dot segment"
			);
		}
		expect(requests).toHaveLength(0);
	} finally {
		Reflect.set(globalThis, "fetch", originalFetch);
	}
});

test("scope guidance writes stay within their route and report prompt changes", async () => {
	const originalFetch = globalThis.fetch;
	const requests: Request[] = [];
	Reflect.set(
		globalThis,
		"fetch",
		(url: RequestInfo | URL, init?: RequestInit) => {
			requests.push(new Request(url, init));
			return Promise.resolve(Response.json({ ok: true, promptChanged: false }));
		}
	);
	const target: ApiTarget = { url: "http://127.0.0.1:7980", token: "t" };
	try {
		const changed = await setScopeGuidance(
			target,
			"agent:worker/../../conversations/victim",
			{ goal: "Ship" }
		);
		expect(changed).toBe(false);
		const url = new URL(requests[0]?.url ?? "");
		expect(url.pathname).toBe(
			`/api/scope-guidance/${encodeURIComponent("agent:worker/../../conversations/victim")}`
		);
		expect(await requests[0]?.json()).toEqual({ goal: "Ship" });
		await expect(setScopeGuidance(target, "..", { goal: "x" })).rejects.toThrow(
			"dot segment"
		);
	} finally {
		Reflect.set(globalThis, "fetch", originalFetch);
	}
});
