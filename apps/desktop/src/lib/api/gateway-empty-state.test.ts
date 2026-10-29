// apps/desktop/src/lib/api/gateway-empty-state.test.ts
//
// Core's gateway proxies answer 200 with a short fallback body when the
// gateway sidecar is down, replies non-2xx, or has audit logging disabled.
// fetchGatewayAudit and fetchBudgetSpend document that they resolve the
// empty state for those bodies rather than throwing, so their response codecs
// must accept exactly what Core sends (apps/core/src/server/mod.rs
// `proxy_gateway_audit` and `gateway_budget_spend`).

import { afterEach, describe, expect, it } from "bun:test";
import { fetchBudgetSpend, fetchGatewayAudit } from "./gateway.ts";

const TARGET = { url: "http://127.0.0.1:7980", token: null, userJwt: null };
const originalFetch = globalThis.fetch;

function serveBody(body: Parameters<typeof Response.json>[0]): void {
	globalThis.fetch = Object.assign(async () => Response.json(body), {
		preconnect: originalFetch.preconnect,
	});
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("fetchGatewayAudit", () => {
	it("resolves Core's gateway-down body (no count) to the empty state", async () => {
		serveBody({
			reachable: false,
			error: "error sending request for url",
			entries: [],
		});
		await expect(fetchGatewayAudit(TARGET)).resolves.toEqual({
			reachable: false,
			entries: [],
			count: 0,
		});
	});

	it("resolves Core's audit-disabled body (non-2xx gateway reply) to the empty state", async () => {
		serveBody({
			reachable: false,
			status: 404,
			error: { error: "audit logging disabled" },
			entries: [],
		});
		await expect(fetchGatewayAudit(TARGET)).resolves.toEqual({
			reachable: false,
			entries: [],
			count: 0,
		});
	});

	it("still rejects a body without entries", async () => {
		serveBody({ reachable: true });
		await expect(fetchGatewayAudit(TARGET)).rejects.toThrow();
	});

	it("accepts the gateway's numeric row id and an older row without newer columns", async () => {
		const current = {
			id: 7,
			request_id: "request-7",
			timestamp: "2026-08-21T00:15:00.000Z",
			event_type: "model_call",
			provider: "openrouter",
			model: "gpt-5",
			input_tokens: 4,
			output_tokens: 2,
			latency_ms: 25,
			prompt_cache_outcome: null,
			eval_score: null,
		};
		const older = {
			event_type: "model_call",
			cost_micro_usd: 1000,
			latency_ms: 40,
		};
		serveBody({ reachable: true, count: 2, entries: [current, older] });
		// The rows are partial wire bodies, not complete `AuditEntry` values, so
		// compare the parsed reply as the untyped payload it passes through.
		const audit: unknown = await fetchGatewayAudit(TARGET);
		expect(audit).toEqual({
			reachable: true,
			entries: [current, older],
			count: 2,
		});
	});

	it("still rejects a row whose present member has the wrong type", async () => {
		serveBody({
			reachable: true,
			count: 1,
			entries: [{ event_type: "model_call", latency_ms: "slow" }],
		});
		await expect(fetchGatewayAudit(TARGET)).rejects.toThrow();
	});
});

describe("fetchBudgetSpend", () => {
	it("resolves Core's gateway-down body (limits: {}) to the empty state", async () => {
		serveBody({
			reachable: false,
			error: "error sending request for url",
			users: {},
			agents: {},
			sessions: {},
			limits: {},
		});
		await expect(fetchBudgetSpend(TARGET)).resolves.toEqual({
			reachable: false,
			currency: "USD",
			unit: "micro_usd",
			users: {},
			agents: {},
			sessions: {},
			limits: { users: {}, agents: {}, session: 0 },
		});
	});

	it("fills only the limit members a reachable gateway omitted", async () => {
		serveBody({
			reachable: true,
			users: { "user-1": 1200 },
			agents: {},
			sessions: { "session-1": 300 },
			limits: { session: 5_000_000 },
		});
		await expect(fetchBudgetSpend(TARGET)).resolves.toEqual({
			reachable: true,
			currency: "USD",
			unit: "micro_usd",
			users: { "user-1": 1200 },
			agents: {},
			sessions: { "session-1": 300 },
			limits: { users: {}, agents: {}, session: 5_000_000 },
		});
	});

	it("still rejects a limits member with the wrong type", async () => {
		serveBody({
			reachable: true,
			users: {},
			agents: {},
			sessions: {},
			limits: { session: "unlimited" },
		});
		await expect(fetchBudgetSpend(TARGET)).rejects.toThrow();
	});
});
