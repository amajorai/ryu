import { afterEach, describe, expect, it, mock } from "bun:test";
import type { UsageEvent } from "@ryu/blocks/desktop/usage-analytics.ts";
import {
	type PluginDocument,
	type PluginValue,
	pluginValueSchema,
} from "./plugin-wire-values.ts";
import {
	fetchUsageAnalytics,
	type UsageAnalyticsQuery,
	withoutDuplicateManagedCharges,
} from "./usage-analytics.ts";

const TARGET = {
	local: true,
	managed: false,
	token: "node-token",
	url: "http://127.0.0.1:7980",
};
const QUERY: UsageAnalyticsQuery = {
	from: new Date("2026-08-21T00:00:00.000Z"),
	granularity: "hourly",
	model: "gpt-5",
	provider: "openrouter",
	to: new Date("2026-08-21T02:00:00.000Z"),
};
const realFetch = globalThis.fetch;
const realLocalStorage = globalThis.localStorage;

function jsonResponse(body: PluginValue, status = 200): Response {
	return Response.json(pluginValueSchema.parse(body), { status });
}

function setStorage(token: string | null): void {
	const values = new Map<string, string>();
	if (token) {
		values.set("ryu_session_token", token);
	}
	const storage: Storage = {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		key: (index) => [...values.keys()][index] ?? null,
		removeItem: (key) => values.delete(key),
		setItem: (key, value) => values.set(key, value),
	};
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
	});
}

function mockFetch(
	handler: (url: string, init?: RequestInit) => Promise<Response>
): ReturnType<typeof mock> {
	const fetchMock = mock((input: RequestInfo | URL, init?: RequestInit) =>
		handler(String(input), init)
	);
	globalThis.fetch = Object.assign(fetchMock, {
		preconnect: realFetch.preconnect,
	});
	return fetchMock;
}

function usageRollup(overrides: PluginDocument = {}) {
	return {
		bucketSeconds: 900,
		events: [
			{
				agentSeconds: 12,
				costMicroUsd: 500,
				errorCount: 1,
				feature: "chat",
				inputTokens: 120,
				latencySamples: 3,
				latencyTotalMs: 450,
				memberId: "member-1",
				model: "gpt-5",
				nodeId: "node-1",
				outputTokens: 30,
				provider: "openrouter",
				requestCount: 3,
				source: "managed",
				timestamp: "2026-08-21T00:15:00.000Z",
				...overrides,
			},
		],
		kind: "rollup",
	};
}

afterEach(() => {
	mock.restore();
	globalThis.fetch = realFetch;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: realLocalStorage,
	});
});

describe("withoutDuplicateManagedCharges", () => {
	it("drops ledger rows already represented by managed audit events", () => {
		const auditEvents: UsageEvent[] = [
			{
				requestId: "req-1",
				source: "managed",
				timestamp: "2026-08-21T00:00:00Z",
			},
		];
		const creditEvents: UsageEvent[] = [
			{
				requestId: "req-1",
				source: "managed",
				timestamp: "2026-08-21T00:00:00Z",
			},
			{
				requestId: "req-2",
				source: "managed",
				timestamp: "2026-08-21T00:01:00Z",
			},
			{ requestId: null, source: "managed", timestamp: "2026-08-21T00:02:00Z" },
		];

		expect(withoutDuplicateManagedCharges(auditEvents, creditEvents)).toEqual([
			creditEvents[1],
			creditEvents[2],
		]);
	});
});

describe("fetchUsageAnalytics canonical rollups", () => {
	it("maps complete node rollups without a raw-event cap", async () => {
		setStorage(null);
		const calls: string[] = [];
		mockFetch(async (url) => {
			calls.push(url);
			return jsonResponse({ ...usageRollup(), reachable: true });
		});

		const data = await fetchUsageAnalytics(QUERY, {
			activeNode: TARGET,
			activeOrgId: null,
			scope: "node",
		});

		expect(data.totals).toMatchObject({
			agentSeconds: 12,
			averageLatencyMs: 150,
			errors: 1,
			inputTokens: 120,
			outputTokens: 30,
			requests: 3,
			spendMicroUsd: 500,
		});
		expect(data.byFeature[0]).toMatchObject({ key: "chat", requests: 3 });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("/api/gateway/audit/usage?");
		expect(calls[0]).toContain("provider=openrouter");
		expect(calls[0]).toContain("model=gpt-5");
		expect(calls[0]).not.toContain("limit=");
	});

	it("keeps purpose and prompt-cache counters from node rollups", async () => {
		setStorage(null);
		mockFetch(async () =>
			jsonResponse({
				...usageRollup({
					cacheReadTokens: 90,
					cacheWriteTokens: 30,
					purpose: "compaction",
				}),
				reachable: true,
			})
		);

		const data = await fetchUsageAnalytics(QUERY, {
			activeNode: TARGET,
			activeOrgId: null,
			scope: "node",
		});

		expect(data.totals).toMatchObject({
			cacheReadTokens: 90,
			cacheWriteTokens: 30,
		});
		expect(data.byPurpose).toEqual([
			expect.objectContaining({
				key: "compaction",
				label: "Context compaction",
				requests: 3,
			}),
		]);
	});

	it("leaves purpose and cache empty for rollups from older Gateways", async () => {
		setStorage(null);
		mockFetch(async () => jsonResponse({ ...usageRollup(), reachable: true }));

		const data = await fetchUsageAnalytics(QUERY, {
			activeNode: TARGET,
			activeOrgId: null,
			scope: "node",
		});

		expect(data.byPurpose).toBeUndefined();
		expect(data.totals.cacheReadTokens + data.totals.cacheWriteTokens).toBe(0);
	});

	it("rejects malformed rollup events", async () => {
		setStorage(null);
		mockFetch(async () =>
			jsonResponse({
				...usageRollup({ requestCount: "three" }),
				reachable: true,
			})
		);

		await expect(
			fetchUsageAnalytics(QUERY, {
				activeNode: TARGET,
				activeOrgId: null,
				scope: "node",
			})
		).rejects.toThrow("Gateway usage rollup response was malformed");
	});

	it("requires Core reachability on node rollups", async () => {
		setStorage(null);
		mockFetch(async () => jsonResponse(usageRollup()));

		await expect(
			fetchUsageAnalytics(QUERY, {
				activeNode: TARGET,
				activeOrgId: null,
				scope: "node",
			})
		).rejects.toThrow("Gateway usage rollup response was malformed");
	});

	it("uses organization rollup costs without fetching ledger detail", async () => {
		setStorage("session-token");
		const calls: string[] = [];
		mockFetch(async (url) => {
			calls.push(url);
			return jsonResponse(usageRollup());
		});

		const data = await fetchUsageAnalytics(QUERY, {
			activeNode: null,
			activeOrgId: "org-1",
			scope: "organization",
		});

		expect(data.totals.spendMicroUsd).toBe(500);
		expect(data.totals.requests).toBe(3);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("/api/aggregation/orgs/org-1/usage/analytics");
		expect(data.availability).toEqual({ supported: true });
	});

	it("retains the legacy organization response and ledger overlay", async () => {
		setStorage("session-token");
		const calls: string[] = [];
		mockFetch(async (url) => {
			calls.push(url);
			if (url.includes("/api/credits/usage")) {
				return jsonResponse({
					entries: [],
					nextCursor: null,
					stats: {
						byModel: [{ amountMicroUsd: 75, count: 1, key: "gpt-5" }],
						byProvider: [{ amountMicroUsd: 75, count: 1, key: "openrouter" }],
						byReason: [],
						creditedMicroUsd: 0,
						durationMs: 100,
						inputTokens: 10,
						outputTokens: 5,
						spentMicroUsd: 75,
						transactions: 1,
					},
				});
			}
			return jsonResponse({
				capped: true,
				events: [
					{
						error: false,
						inputTokens: 10,
						latencyMs: 100,
						memberId: "member-1",
						model: "gpt-5",
						nodeId: "node-1",
						outputTokens: 5,
						provider: "openrouter",
						requestId: "request-1",
						source: "managed",
						timestamp: "2026-08-21T00:15:00.000Z",
					},
				],
			});
		});

		const data = await fetchUsageAnalytics(QUERY, {
			activeNode: null,
			activeOrgId: "org-1",
			scope: "organization",
		});

		expect(calls).toHaveLength(2);
		expect(data.totals.requests).toBe(1);
		expect(data.totals.spendMicroUsd).toBe(75);
		expect(data.availability?.message).toContain("20,000 events");
	});

	it("falls back to raw node audit through a mixed-version Core proxy", async () => {
		setStorage(null);
		const calls: string[] = [];
		mockFetch(async (url) => {
			calls.push(url);
			if (url.includes("/api/gateway/audit/usage")) {
				return jsonResponse({
					bucketSeconds: 900,
					events: [],
					kind: "rollup",
					reachable: false,
					status: 404,
				});
			}
			return jsonResponse({
				count: 1,
				entries: [
					{
						cost_micro_usd: null,
						error: null,
						feature: "chat",
						input_tokens: 4,
						latency_ms: 25,
						model: "gpt-5",
						output_tokens: 2,
						provider: "openrouter",
						timestamp: "2026-08-21T00:15:00.000Z",
						user_id: "member-1",
					},
				],
				reachable: true,
			});
		});

		const data = await fetchUsageAnalytics(QUERY, {
			activeNode: TARGET,
			activeOrgId: null,
			scope: "node",
		});

		expect(calls).toHaveLength(2);
		expect(calls[1]).toContain("/api/gateway/audit?");
		expect(calls[1]).not.toContain("limit=");
		expect(data.totals).toMatchObject({ requests: 1, averageLatencyMs: 25 });
	});

	it("keeps purpose from raw node audit rows when the rollup is unavailable", async () => {
		setStorage(null);
		mockFetch(async (url) => {
			if (url.includes("/api/gateway/audit/usage")) {
				return jsonResponse({
					bucketSeconds: 900,
					events: [],
					kind: "rollup",
					reachable: false,
					status: 404,
				});
			}
			const row = {
				cost_micro_usd: null,
				error: null,
				feature: "chat",
				input_tokens: 4,
				latency_ms: 25,
				model: "gpt-5",
				output_tokens: 2,
				provider: "openrouter",
				timestamp: "2026-08-21T00:15:00.000Z",
				user_id: "member-1",
			};
			return jsonResponse({
				count: 2,
				entries: [
					{ ...row, purpose: "compaction" },
					{ ...row, purpose: null },
				],
				reachable: true,
			});
		});

		const data = await fetchUsageAnalytics(QUERY, {
			activeNode: TARGET,
			activeOrgId: null,
			scope: "node",
		});

		expect(data.byPurpose).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "compaction", requests: 1 }),
			])
		);
	});

	it("returns the supported offline empty state", async () => {
		setStorage(null);
		mockFetch(async () =>
			jsonResponse({
				bucketSeconds: 900,
				events: [],
				kind: "rollup",
				reachable: false,
			})
		);

		const data = await fetchUsageAnalytics(QUERY, {
			activeNode: TARGET,
			activeOrgId: null,
			scope: "node",
		});

		expect(data.availability).toEqual({
			message: "This node is offline or its audit history is unavailable.",
			supported: false,
		});
		expect(data.totals.requests).toBe(0);
	});
});
