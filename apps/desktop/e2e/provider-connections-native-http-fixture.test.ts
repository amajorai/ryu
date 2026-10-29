import { afterAll, beforeEach, expect, test } from "bun:test";
import { ProviderState } from "./provider-connections-native-http-state.ts";

const state = new ProviderState();
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		return (
			(await state.handle(request)) ??
			Response.json({ error: "Unowned route" }, { status: 404 })
		);
	},
});
const headers = {
	authorization: "Bearer provider-retry-owned-token",
	"content-type": "application/json",
};
const request = (path: string, method = "GET", body?: unknown) =>
	fetch(new URL(path, server.url), {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
beforeEach(() => Object.assign(state, new ProviderState()));
afterAll(() => {
	for (const gate of state.holds.values()) {
		gate.release();
	}
	server.stop(true);
});
test("fixture genuine refused credential POST cannot publish; exact retry readback excludes key from catalog", async () => {
	state.refusals.set("POST /api/pi-config/providers", 503);
	const body = {
		provider: "local-model-server",
		apiKey: "synthetic-replacement",
	};
	expect((await request("/api/pi-config/providers", "POST", body)).status).toBe(
		503
	);
	expect(state.secrets).toEqual({});
	state.refusals.clear();
	expect((await request("/api/pi-config/providers", "POST", body)).status).toBe(
		200
	);
	expect(state.secrets["local-model-server"]).toBe("synthetic-replacement");
	const text = await (await request("/api/pi-config/catalog")).text();
	expect(text).not.toContain("synthetic-replacement");
	expect(
		state.calls.filter((c) => c.method === "POST").map((c) => c.body)
	).toEqual([body, body]);
	expect(state.unexpected).toEqual([]);
});
test("fixture rejects wrong verb, credential and extra write payload rather than green fallback", async () => {
	expect((await request("/api/pi-config/catalog", "DELETE")).status).toBe(400);
	expect(
		(
			await fetch(new URL("/api/pi-config/catalog", server.url), {
				headers: { authorization: "Bearer foreign" },
			})
		).status
	).toBe(400);
	expect(
		(
			await request("/api/pi-config/providers", "POST", {
				provider: "local-model-server",
				apiKey: "secret",
				accidental: true,
			})
		).status
	).toBe(400);
	expect(state.secrets).toEqual({});
	expect(state.unexpected).toHaveLength(3);
});
test("model overrides and account choices survive independent catalog GET; removing one account preserves peer", async () => {
	expect(
		(
			await request("/api/pi-config/providers/model-enabled", "POST", {
				provider: "openrouter",
				model: "remote-model",
				enabled: false,
			})
		).status
	).toBe(200);
	expect(
		(
			await request(
				"/api/pi-config/providers/openrouter/accounts/switch",
				"POST",
				{ accountId: "or-b", target: "self" }
			)
		).status
	).toBe(200);
	expect(
		(
			await request(
				"/api/pi-config/providers/openrouter/accounts/rename",
				"POST",
				{ accountId: "or-b", label: "Owned renamed" }
			)
		).status
	).toBe(200);
	expect(
		(
			await request(
				"/api/pi-config/providers/openrouter/accounts/remove",
				"POST",
				{ accountId: "or-a" }
			)
		).status
	).toBe(200);
	const catalog = await (await request("/api/pi-config/catalog")).json();
	const p = catalog.providers.find(
		(p: { id: string }) => p.id === "openrouter"
	);
	expect(p.modelOverrides).toEqual({ "remote-model": false });
	expect(
		p.accounts.map(
			(a: { accountId: string; label: string; active: boolean }) => ({
				id: a.accountId,
				label: a.label,
				active: a.active,
			})
		)
	).toEqual([{ id: "or-b", label: "Owned renamed", active: true }]);
	expect(state.unexpected).toEqual([]);
});
test("exact pool policy PUT and GET preserve whole account rules; refused retry leaves initial policy intact", async () => {
	const body = {
		strategy: "round_robin",
		drainThresholdPercent: 80,
		accounts: {
			"chatgpt-a": { enabled: true, priority: 0 },
			"chatgpt-b": { enabled: true, priority: 2 },
		},
	};
	const path = "/api/pi-config/providers/chatgpt/account-pool";
	state.refusals.set(`PUT ${path}`, 503);
	expect((await request(path, "PUT", body)).status).toBe(503);
	expect((await (await request(path)).json()).strategy).toBe("manual");
	state.refusals.clear();
	expect((await request(path, "PUT", body)).status).toBe(200);
	expect(await (await request(path)).json()).toEqual(body);
	expect(state.unexpected).toEqual([]);
});
test("composed real host shares strict native prerequisite route handling with the genuine provider contract", async () => {
	const { startProviderConnectionsProofHost } = await import(
		"./provider-connections-native-http.host.ts"
	);
	const host = startProviderConnectionsProofHost(0);
	try {
		const response = await fetch(
			new URL("/api/pi-config/catalog", host.server.url),
			{ headers }
		);
		expect(response.status).toBe(200);
		expect(
			(await response.json()).providers.map((p: { id: string }) => p.id)
		).toEqual(["chatgpt", "openrouter", "local-model-server"]);
		const preference = await fetch(
			new URL("/api/preferences/managed-inference-entitled", host.server.url),
			{ method: "PUT", headers, body: JSON.stringify({ value: "false" }) }
		);
		expect(preference.status).toBe(200);
		expect(await preference.json()).toEqual({
			ok: true,
			key: "managed-inference-entitled",
		});
		const snapshot = await (
			await fetch(new URL("/__state", host.server.url))
		).json();
		expect(snapshot.preferences["managed-inference-entitled"]).toBe("false");
		expect(snapshot.unexpected).toEqual([]);
	} finally {
		host.stop();
	}
});

test("fixture rejects malformed API and thinking-level values without saving configuration", async () => {
	const before = structuredClone(state.config);
	for (const body of [
		{
			provider: "openrouter",
			model: "remote-model",
			thinkingLevel: "invented-tier",
			api: "openai-completions",
		},
		{
			provider: "openrouter",
			model: "remote-model",
			thinkingLevel: null,
			api: false,
		},
	]) {
		expect((await request("/api/pi-config", "PUT", body)).status).toBe(400);
		expect(await (await request("/api/pi-config")).json()).toEqual({
			config: before,
		});
	}
	expect(state.unexpected).toHaveLength(2);
});
test("Core boolean preference fixture refuses JSON booleans; only string values are acknowledged", async () => {
	const { startProviderConnectionsProofHost } = await import(
		"./provider-connections-native-http.host.ts"
	);
	const host = startProviderConnectionsProofHost(0);
	try {
		const path = "/api/preferences/managed-inference-entitled";
		const bad = await fetch(new URL(path, host.server.url), {
			method: "PUT",
			headers,
			body: JSON.stringify({ value: true }),
		});
		expect(bad.status).toBe(400);
		const snapshot = await (
			await fetch(new URL("/__state", host.server.url))
		).json();
		expect(snapshot.preferences).toEqual({});
		expect(snapshot.unexpected).toHaveLength(1);
		const good = await fetch(new URL(path, host.server.url), {
			method: "PUT",
			headers,
			body: JSON.stringify({ value: "true" }),
		});
		expect(good.status).toBe(200);
		expect(await good.json()).toEqual({
			ok: true,
			key: "managed-inference-entitled",
		});
	} finally {
		host.stop();
	}
});
