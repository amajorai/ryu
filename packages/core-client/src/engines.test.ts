// packages/core-client/src/engines.test.ts
//
// Tests for the engines client. fetchEngines / fetchEngineModels / fetchActiveEngine
// are snake→camel mappers with `?? default` degradation. setActiveEngine is the
// interesting one: it throws ONLY on an explicit `success === false` (an omitted
// flag proceeds), and applies an OPTIMISTIC `gateway_refreshed ?? true` default so
// a swap that omits the flag is treated as fully routed.

import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	fetchActiveEngine,
	fetchEngineModels,
	fetchEngines,
	setActiveEngine,
} from "./engines.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const target: ApiTarget = { url: "http://127.0.0.1:7980", token: "t" };

interface Captured {
	init?: RequestInit;
	url?: string;
}

function stub(bodyText: string, status = 200): Captured {
	const cap: Captured = {};
	globalThis.fetch = ((url: string, init: RequestInit) => {
		cap.url = url;
		cap.init = init;
		return Promise.resolve(new Response(bodyText, { status }));
	}) as typeof fetch;
	return cap;
}

describe("fetchEngines", () => {
	test("maps install_hint→installHint and defaults the optionals", async () => {
		const cap = stub(
			JSON.stringify({
				engines: [
					{ id: "claude", name: "Claude" },
					{
						id: "llamacpp",
						name: "llama.cpp",
						description: "local",
						install_hint: "brew install",
						installed: true,
					},
				],
			})
		);
		const engines = await fetchEngines(target);
		expect(cap.url).toBe("http://127.0.0.1:7980/api/engines");
		expect(engines[0]).toEqual({
			id: "claude",
			name: "Claude",
			description: null,
			installHint: null,
			installed: null,
		});
		expect(engines[1]).toEqual({
			id: "llamacpp",
			name: "llama.cpp",
			description: "local",
			installHint: "brew install",
			installed: true,
		});
	});

	test("falls back to [] when engines is absent", async () => {
		stub("{}");
		expect(await fetchEngines(target)).toEqual([]);
	});
});

describe("fetchEngineModels", () => {
	test("returns the keyed model map", async () => {
		stub(
			JSON.stringify({
				models: { claude: [{ id: "opus", name: "Opus" }] },
			})
		);
		expect(await fetchEngineModels(target)).toEqual({
			claude: [{ id: "opus", name: "Opus" }],
		});
	});

	test("falls back to {} when models is absent", async () => {
		stub("{}");
		expect(await fetchEngineModels(target)).toEqual({});
	});
});

describe("fetchActiveEngine", () => {
	test("maps the resident-engine snapshot", async () => {
		stub(
			JSON.stringify({
				active: "llamacpp",
				running: true,
				available: ["llamacpp", "ollama"],
			})
		);
		expect(await fetchActiveEngine(target)).toEqual({
			active: "llamacpp",
			running: true,
			available: ["llamacpp", "ollama"],
		});
	});

	test("defaults null/false/[] when the snapshot is empty", async () => {
		stub("{}");
		expect(await fetchActiveEngine(target)).toEqual({
			active: null,
			running: false,
			available: [],
		});
	});
});

describe("setActiveEngine", () => {
	test("POSTs the engine name and maps the swap result", async () => {
		const cap = stub(
			JSON.stringify({
				success: true,
				active: "ollama",
				stopped: "llamacpp",
				running: true,
				unchanged: false,
				gateway_refreshed: true,
			})
		);
		const swap = await setActiveEngine(target, "ollama");
		expect(cap.url).toBe("http://127.0.0.1:7980/api/engine/active");
		expect(cap.init?.method).toBe("POST");
		expect(JSON.parse(cap.init?.body as string)).toEqual({ name: "ollama" });
		expect(swap).toEqual({
			active: "ollama",
			stopped: "llamacpp",
			running: true,
			unchanged: false,
			gatewayRefreshed: true,
		});
	});

	test("throws only on an explicit success === false", async () => {
		stub(JSON.stringify({ success: false, error: "engine not installed" }));
		await expect(setActiveEngine(target, "vllm")).rejects.toThrow(
			"engine not installed"
		);
	});

	test("throws a default error when success is false without a message", async () => {
		stub(JSON.stringify({ success: false }));
		await expect(setActiveEngine(target, "vllm")).rejects.toThrow(
			'Failed to activate engine "vllm"'
		);
	});

	test("proceeds when success is omitted, optimistically assuming gateway refreshed", async () => {
		// No success flag and no gateway_refreshed → not an error, and the gateway
		// is assumed routed (?? true) rather than defaulting to stale.
		stub(JSON.stringify({ active: "ollama", running: true }));
		const swap = await setActiveEngine(target, "ollama");
		expect(swap.active).toBe("ollama");
		expect(swap.gatewayRefreshed).toBe(true);
		expect(swap.unchanged).toBe(false);
	});

	test("surfaces a swap that succeeded but left the gateway stale", async () => {
		stub(
			JSON.stringify({
				success: true,
				active: "ollama",
				running: true,
				gateway_refreshed: false,
			})
		);
		const swap = await setActiveEngine(target, "ollama");
		expect(swap.gatewayRefreshed).toBe(false);
	});
});
