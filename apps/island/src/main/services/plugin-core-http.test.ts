// The gate in front of the Island's authenticated Core HTTP (Security finding
// SA-10). Nothing here makes a request. The base URL is only text for the URL
// parser, and the sender is a stand-in that records what it is asked to send.

import { expect, test } from "bun:test";
import type {
	PluginCoreHttpOwner,
	PluginCoreHttpRequest,
	PluginCoreHttpResult,
} from "../../shared/ipc.ts";
import {
	type CoreHttpAllowed,
	coreHttpTarget,
	pluginCoreHttpVia,
} from "./plugin-core-http.ts";

const BASE = "http://127.0.0.1:7980";
const OWNER = "com.example.app";
const SEPARATORS = ["\t", "\n", "\r"];
const community: PluginCoreHttpOwner = {
	kind: "contribution",
	plugin: OWNER,
	http_policy: "owner",
};
const firstParty: PluginCoreHttpOwner = {
	kind: "contribution",
	plugin: "@ryu/meetings",
	http_policy: "core",
};
const host: PluginCoreHttpOwner = { kind: "host" };

/** A sender that never touches the network. */
function standIn() {
	const sent: { body: unknown; target: CoreHttpAllowed }[] = [];
	const send = (
		target: CoreHttpAllowed,
		body: unknown
	): Promise<PluginCoreHttpResult> => {
		sent.push({ body, target });
		return Promise.resolve({ ok: true, status: 200, data: { value: 1 } });
	};
	return { sent, send };
}

function request(
	owner: PluginCoreHttpOwner,
	path: string,
	method = "GET"
): PluginCoreHttpRequest {
	return { method, owner, path };
}

function allowed(owner: PluginCoreHttpOwner, path: string, method = "GET") {
	return coreHttpTarget(request(owner, path, method), BASE).ok;
}

/** Looks like a path under the owner's mount. A parser sends it elsewhere. */
function smuggled(separator: string): string {
	return `/api/ext/${OWNER}/.${separator}./.${separator}./conversations?preview=1`;
}

test("pluginCoreHttp refuses a path with a tab, line feed or carriage return before any fetch", async () => {
	const { sent, send } = standIn();
	for (const separator of SEPARATORS) {
		// What a URL parser would send for it.
		const url = new URL(`${BASE}${smuggled(separator)}`);
		expect(url.pathname).toBe("/api/conversations");
	}
	const results = await Promise.all(
		SEPARATORS.flatMap((separator) =>
			["GET", "DELETE"].map((method) =>
				pluginCoreHttpVia(
					request(community, smuggled(separator), method),
					BASE,
					send
				)
			)
		)
	);
	expect(results).toHaveLength(6);
	for (const result of results) {
		expect(result).toMatchObject({ ok: false, code: "invalid_args" });
	}
	expect(sent).toEqual([]);
});

test("a Community view reaches its own mount and nothing else", () => {
	const owned = `/api/ext/${OWNER}/items?window=today`;
	expect(coreHttpTarget(request(community, owned), BASE)).toEqual({
		ok: true,
		method: "GET",
		path: owned,
		url: `${BASE}${owned}`,
	});
	expect(allowed(community, `/api/ext/${OWNER}`)).toBe(true);
	for (const path of [
		"/api/conversations",
		"/api/agents",
		"/api/ext/other.app/items",
		`/api/ext/${OWNER}.other/items`,
		`/api/ext/${OWNER}/../other.app/items`,
		`/api/ext/${OWNER}/%2e%2e/other.app/items`,
		`//evil.example/api/ext/${OWNER}/items`,
		`@evil.example/api/ext/${OWNER}/items`,
		`.evil.example/api/ext/${OWNER}/items`,
	]) {
		expect(allowed(community, path)).toBe(false);
		expect(allowed(community, path, "POST")).toBe(false);
	}
});

test("a policy Core did not stamp counts as the owner mount", () => {
	for (const policy of [undefined, "CORE", true, { core: true }]) {
		const owner: PluginCoreHttpOwner = {
			kind: "contribution",
			plugin: OWNER,
			http_policy: policy,
		};
		expect(allowed(owner, "/api/conversations")).toBe(false);
		expect(allowed(owner, `/api/ext/${OWNER}/items`)).toBe(true);
	}
	const unowned: PluginCoreHttpOwner = {
		kind: "contribution",
		plugin: undefined,
		http_policy: "core",
	};
	expect(allowed(unowned, "/api/conversations")).toBe(false);
});

test("a first-party view keeps Core routes, without control characters", () => {
	expect(allowed(firstParty, "/api/meetings")).toBe(true);
	expect(allowed(firstParty, "/api/meetings/m1/notes", "POST")).toBe(true);
	expect(allowed(firstParty, "/workflows")).toBe(true);
	expect(allowed(firstParty, "/health")).toBe(false);
	for (const separator of SEPARATORS) {
		const path = `/api/.${separator}./.${separator}./health`;
		expect(allowed(firstParty, path)).toBe(false);
	}
});

test("the host's own calls are limited to its fixed routes", () => {
	expect(allowed(host, "/api/agents")).toBe(true);
	expect(allowed(host, "/api/widgets/tools/call", "POST")).toBe(true);
	expect(allowed(host, "/api/widgets/follow-up", "POST")).toBe(true);
	expect(allowed(host, "/api/widgets/state", "POST")).toBe(true);
	expect(allowed(host, "/api/agents", "POST")).toBe(false);
	expect(allowed(host, "/api/agents/")).toBe(false);
	expect(allowed(host, "/api/agents?all=1")).toBe(false);
	expect(allowed(host, "/api/conversations")).toBe(false);
	expect(allowed(host, "/api/widgets/state")).toBe(false);
	expect(allowed(host, "/api/widgets/\tstate", "POST")).toBe(false);
});

test("a call that names no owner, or an unknown method, is refused", () => {
	// The request crosses IPC, so main may receive any shape.
	const bare: PluginCoreHttpRequest = JSON.parse(
		'{"method":"GET","path":"/api/agents"}'
	);
	expect(coreHttpTarget(bare, BASE).ok).toBe(false);
	expect(allowed(community, `/api/ext/${OWNER}/items`, "TRACE")).toBe(false);
	expect(allowed(community, `/api/ext/${OWNER}/items`, "delete")).toBe(true);
});

test("an allowed call is sent once, with its body, to the URL that was tested", async () => {
	const { sent, send } = standIn();
	const path = `/api/ext/${OWNER}/items`;
	const result = await pluginCoreHttpVia(
		{ ...request(community, path, "post"), body: { title: "a" } },
		`${BASE}/node-a`,
		send
	);
	expect(result).toEqual({ ok: true, status: 200, data: { value: 1 } });
	expect(sent).toEqual([
		{
			body: { title: "a" },
			target: {
				ok: true,
				method: "POST",
				path,
				url: `${BASE}/node-a${path}`,
			},
		},
	]);
});
