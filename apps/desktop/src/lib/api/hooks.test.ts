import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { parseHookInventory, updateHookOverride } from "./hooks.ts";

describe("parseHookInventory", () => {
	it("keeps safe handler metadata and drops executable code", () => {
		const parsed = parseHookInventory({
			hooks: [
				{
					code: "return fetch('https://example.com')",
					effectiveEnabled: false,
					enabled: true,
					handler: {
						display: "Sandboxed JavaScript",
						kind: "sandbox_js",
						path: "hooks/review.js",
					},
					hookKey: "com.example.reviewer::review",
					id: "review",
					matcher: { flag: "review" },
					ownerId: "com.example.reviewer",
					ownerName: "Reviewer",
					phase: "post_assistant_turn",
					pluginEnabled: true,
					priority: 4,
					reviewRequired: true,
					source: "plugin",
					trusted: false,
				},
			],
		});

		expect(parsed.hooks[0]?.handler.path).toBe("hooks/review.js");
		expect("code" in (parsed.hooks[0] ?? {})).toBe(false);
	});

	it("rejects malformed handler kinds", () => {
		expect(() =>
			parseHookInventory({
				hooks: [
					{
						effectiveEnabled: true,
						enabled: true,
						handler: { display: "Native", kind: "native" },
						hookKey: "bad::bad",
						id: "bad",
						ownerId: "bad",
						ownerName: "Bad",
						phase: "stop",
						pluginEnabled: true,
						priority: 0,
						reviewRequired: false,
						source: "plugin",
						trusted: true,
					},
				],
			})
		).toThrow("invalid hook handler");
	});
});

describe("updateHookOverride", () => {
	it("writes one hook at one local scope", async () => {
		const originalFetch = globalThis.fetch;
		let body = "";
		const fakeFetch = Object.assign(
			async (...args: Parameters<typeof fetch>) => {
				const init = args[1];
				body = z.string().catch("").parse(init?.body);
				return new Response(JSON.stringify({ hooks: [] }), {
					headers: { "content-type": "application/json" },
					status: 200,
				});
			},
			{ preconnect: originalFetch.preconnect }
		);
		globalThis.fetch = fakeFetch;

		try {
			await updateHookOverride(
				{ token: null, url: "http://127.0.0.1:7980", userJwt: null },
				{
					hookKey: "com.example.reviewer::review",
					policy: { enabled: false, trusted: true },
					scope: "user",
				}
			);
			expect(JSON.parse(body)).toEqual({
				hookKey: "com.example.reviewer::review",
				policy: { enabled: false, trusted: true },
				scope: "user",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("hook field normalization", () => {
	const hook = {
		effectiveEnabled: false,
		enabled: false,
		handler: { display: "Command", kind: "command" },
		hookKey: "hook",
		id: "id",
		ownerId: "owner",
		ownerName: "Owner",
		phase: "pre",
		priority: 0,
		reviewRequired: false,
		source: "config",
		trusted: false,
	};
	it("keeps matcher JSON identity and optional override omission", () => {
		const matcher = JSON.parse(
			'{"__proto__":{"future":true},"future":[1,null]}'
		);
		const parsed = parseHookInventory({
			hooks: [
				{
					...hook,
					matcher,
					localOverrides: {
						node: { enabled: false, trusted: "invalid" },
						user: [],
					},
					pluginEnabled: "invalid",
				},
			],
		}).hooks[0];
		expect(parsed?.matcher).toBe(matcher);
		expect(parsed?.localOverrides).toEqual({ node: { enabled: false } });
		expect(parsed?.pluginEnabled).toBe(true);
		expect(Object.hasOwn(parsed?.handler ?? {}, "path")).toBe(false);
	});
	it("preserves error messages and validation order", () => {
		expect(() =>
			parseHookInventory({
				hooks: [{ ...hook, source: "future", priority: 0.5 }],
			})
		).toThrow("invalid hook source");
		expect(() =>
			parseHookInventory({
				hooks: [{ ...hook, priority: 0.5, effectiveEnabled: "invalid" }],
			})
		).toThrow("invalid hook priority");
		expect(() =>
			parseHookInventory({
				hooks: [{ ...hook, effectiveEnabled: "invalid", handler: null }],
			})
		).toThrow("invalid hook effectiveEnabled");
		expect(() => parseHookInventory({ hooks: [null] })).toThrow(
			"invalid hook inventory item"
		);
		expect(() => parseHookInventory({ hooks: null })).toThrow(
			"invalid hook inventory"
		);
	});
});
