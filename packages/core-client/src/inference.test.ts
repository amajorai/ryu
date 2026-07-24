// packages/core-client/src/inference.test.ts
//
// Tests for the launch-config transport (`isLocalEngine` lives in
// pure-helpers.test). `getModelLaunchConfig` must FAIL OPEN — an unsaved config
// (`launch_config: null`) and an unreachable endpoint (throw) both degrade to an
// empty object so the editor still renders. `saveModelLaunchConfig` PUTs the
// config and URL-encodes the model id (ids can contain slashes, e.g.
// "org/model").

import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import { getModelLaunchConfig, saveModelLaunchConfig } from "./inference.ts";

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

describe("getModelLaunchConfig", () => {
	test("returns the saved config when present", async () => {
		stub(JSON.stringify({ launch_config: { ctx_size: 8192, jinja: true } }));
		expect(await getModelLaunchConfig(target, "m1")).toEqual({
			ctx_size: 8192,
			jinja: true,
		});
	});

	test("degrades to {} when no config is saved (launch_config: null)", async () => {
		stub(JSON.stringify({ launch_config: null }));
		expect(await getModelLaunchConfig(target, "m1")).toEqual({});
	});

	test("degrades to {} when the field is missing entirely", async () => {
		stub("{}");
		expect(await getModelLaunchConfig(target, "m1")).toEqual({});
	});

	test("fails open to {} when the endpoint is unavailable (non-2xx)", async () => {
		stub("nope", 404);
		expect(await getModelLaunchConfig(target, "m1")).toEqual({});
	});

	test("fails open to {} when fetch itself rejects", async () => {
		globalThis.fetch = (() =>
			Promise.reject(new Error("network down"))) as typeof fetch;
		expect(await getModelLaunchConfig(target, "m1")).toEqual({});
	});

	test("URL-encodes the model id", async () => {
		const cap = stub(JSON.stringify({ launch_config: {} }));
		await getModelLaunchConfig(target, "org/model:q4");
		expect(cap.url).toBe(
			"http://127.0.0.1:7980/api/models/org%2Fmodel%3Aq4/launch-config"
		);
	});
});

describe("saveModelLaunchConfig", () => {
	test("PUTs the config to the encoded endpoint", async () => {
		const cap = stub("{}");
		await saveModelLaunchConfig(target, "org/model", { gpu_layers: 30 });
		expect(cap.url).toBe(
			"http://127.0.0.1:7980/api/models/org%2Fmodel/launch-config"
		);
		expect(cap.init?.method).toBe("PUT");
		expect(JSON.parse(cap.init?.body as string)).toEqual({ gpu_layers: 30 });
	});
});
