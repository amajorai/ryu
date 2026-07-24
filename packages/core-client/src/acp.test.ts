// packages/core-client/src/acp.test.ts
//
// Tests for the ACP session-config client (`flattenConfigOptions` lives in
// pure-helpers.test). `fetchAcpConfig` URL-encodes the agent id and returns the
// all-null advertisement verbatim for a non-ACP agent. `respondPermission` POSTs
// the mid-turn permission decision with Core's snake_case body shape
// (`request_id` / `option_id`), including the reject case where `option_id` is
// null.

import { afterEach, describe, expect, test } from "bun:test";
import { fetchAcpConfig, respondPermission } from "./acp.ts";
import type { ApiTarget } from "./client.ts";

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

describe("fetchAcpConfig", () => {
	test("URL-encodes the agent id and returns the advertisement", async () => {
		const cap = stub(
			JSON.stringify({
				modes: { availableModes: [], currentModeId: "default" },
				models: null,
				configOptions: null,
			})
		);
		const cfg = await fetchAcpConfig(target, "agent/one");
		expect(cap.url).toBe(
			"http://127.0.0.1:7980/api/agents/agent%2Fone/acp-config"
		);
		expect(cfg.models).toBeNull();
		expect(cfg.modes?.currentModeId).toBe("default");
	});

	test("passes through the all-null shape for a non-ACP agent", async () => {
		stub(JSON.stringify({ modes: null, models: null, configOptions: null }));
		expect(await fetchAcpConfig(target, "plain")).toEqual({
			modes: null,
			models: null,
			configOptions: null,
		});
	});
});

describe("respondPermission", () => {
	test("POSTs the snake_case body with the chosen option", async () => {
		const cap = stub(JSON.stringify({ resolved: true }));
		const res = await respondPermission(target, "req-1", "allow_once");
		expect(res).toEqual({ resolved: true });
		expect(cap.url).toBe("http://127.0.0.1:7980/api/chat/permission");
		expect(cap.init?.method).toBe("POST");
		expect(JSON.parse(cap.init?.body as string)).toEqual({
			request_id: "req-1",
			option_id: "allow_once",
		});
	});

	test("carries a null option_id for a reject/cancel", async () => {
		const cap = stub(JSON.stringify({ resolved: false }));
		await respondPermission(target, "req-2", null);
		expect(JSON.parse(cap.init?.body as string)).toEqual({
			request_id: "req-2",
			option_id: null,
		});
	});
});
