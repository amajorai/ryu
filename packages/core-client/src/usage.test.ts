// packages/core-client/src/usage.test.ts
//
// Tests for the shared subscription usage wire model: the snake_case
// `UsageSnapshot` conversion, the camelCase subscriptions snapshot/reading
// schemas (loose, and tolerant of values a newer Core may add), the owner HTTP
// fetchers' query strings, the node-scoped query keys and the shared pool
// predicates.

import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import { createFetchFixture } from "./test-support/http-fixture.ts";
import {
	eligiblePoolAccounts,
	fetchProviderUsageReading,
	fetchSubscriptionsSnapshot,
	hasReadableAccountWindows,
	type ProviderUsageReading,
	providerUsageReadingSchema,
	type SubscriptionProvider,
	subscriptionQueryKeys,
	subscriptionsSnapshotSchema,
	toUsageSnapshot,
	usageSnapshotWireSchema,
} from "./usage.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const target: ApiTarget = {
	url: "http://127.0.0.1:7980",
	token: "t",
	userJwt: null,
};

const readingFixture = {
	providerId: "claude-pro-max",
	accountId: "acct_1",
	accountLabel: "me@example.com",
	engine: "claude",
	available: true,
	observedAt: "2026-10-14T00:00:00Z",
	cached: true,
	windows: [
		{
			targetId: "window:Session::18000",
			label: "Session",
			window: "5h",
			windowSeconds: 18_000,
			scope: "account",
			model: null,
			usedPercent: 42.5,
			remainingPercent: 57.5,
			resetsAt: null,
		},
	],
	meters: [],
};

function accountFixture(overrides: Record<string, unknown>) {
	return {
		accountId: "acct_1",
		label: "me@example.com",
		kind: "oauth",
		active: true,
		gatewayActive: false,
		needsReauth: false,
		updatedAt: 1,
		poolEnabled: true,
		poolPriority: null,
		state: "ok",
		usage: null,
		...overrides,
	};
}

const snapshotFixture = {
	version: 1,
	generatedAt: "2026-10-14T00:00:00Z",
	providers: [
		{
			providerId: "claude-pro-max",
			label: "Claude Pro/Max",
			kind: "subscription",
			managed: false,
			capabilities: {
				accountUsage: true,
				accountPing: true,
				accountPinning: "sdk",
				poolStrategies: ["manual", "round_robin"],
				quotaObservations: true,
			},
			policy: { strategy: "round_robin", drainThresholdPercent: 90 },
			activeAccountId: "acct_1",
			accounts: [
				accountFixture({ usage: readingFixture }),
				accountFixture({
					accountId: "acct_2",
					active: false,
					needsReauth: true,
					state: "needs_reauth",
				}),
				accountFixture({
					accountId: "acct_3",
					active: false,
					poolEnabled: false,
					state: "pool_disabled",
				}),
				accountFixture({
					accountId: "acct_4",
					active: false,
					kind: "opaque",
					state: "unsupported",
				}),
				accountFixture({
					accountId: "acct_5",
					active: false,
					state: "pending",
				}),
			],
		},
	],
};

describe("usage snapshot wire", () => {
	test("converts snake_case to the camelCase model and keeps vault identity", () => {
		const wire = usageSnapshotWireSchema.parse({
			agent_id: "claude-pro-max",
			provider_id: "claude-pro-max",
			account_id: "acct_1",
			engine: "claude",
			available: true,
			windows: [{ label: "Weekly", used_percent: 10, model: "opus" }],
			meters: [
				{
					label: "Credits",
					values: [{ number: 3, kind: "count", unit: "credits" }],
				},
			],
		});
		expect(toUsageSnapshot(wire)).toEqual({
			agentId: "claude-pro-max",
			providerId: "claude-pro-max",
			accountId: "acct_1",
			engine: "claude",
			available: true,
			plan: null,
			reason: null,
			windows: [
				{
					label: "Weekly",
					usedPercent: 10,
					resetsAt: null,
					windowSeconds: null,
					model: "opus",
				},
			],
			meters: [
				{
					label: "Credits",
					values: [
						{ number: 3, kind: "count", currency: null, unit: "credits" },
					],
					expiresAt: [],
					resetsAt: null,
				},
			],
			extraUsageUsd: null,
			retryAfterSeconds: null,
		});
	});

	test("older Core without vault identity leaves the fields absent", () => {
		const snapshot = toUsageSnapshot(
			usageSnapshotWireSchema.parse({
				agent_id: "acp:codex",
				engine: "codex",
				available: false,
				reason: "not_logged_in",
				windows: [],
			})
		);
		expect("providerId" in snapshot).toBe(false);
		expect("accountId" in snapshot).toBe(false);
		expect(snapshot.reason).toBe("not_logged_in");
		expect(snapshot.meters).toEqual([]);
	});

	test("an unknown future reason degrades to error", () => {
		const snapshot = toUsageSnapshot(
			usageSnapshotWireSchema.parse({
				agent_id: "a",
				engine: "claude",
				available: false,
				reason: "quota_frozen",
				windows: [],
			})
		);
		expect(snapshot.reason).toBe("error");
	});
});

describe("subscriptions schemas", () => {
	test("parse the canonical snapshot and keep unknown fields", () => {
		const parsed = subscriptionsSnapshotSchema.parse({
			...snapshotFixture,
			futureField: 1,
		});
		expect(parsed.providers[0]?.accounts[0]?.usage?.accountId).toBe("acct_1");
		expect(parsed.providers[0]?.policy?.strategy).toBe("round_robin");
		expect((parsed as Record<string, unknown>).futureField).toBe(1);
	});

	test("unknown states, strategies and reasons degrade instead of failing", () => {
		const parsed = subscriptionsSnapshotSchema.parse({
			...snapshotFixture,
			providers: [
				{
					...snapshotFixture.providers[0],
					capabilities: {
						...snapshotFixture.providers[0]?.capabilities,
						accountPinning: "teleport",
						poolStrategies: ["manual", "lottery"],
					},
					policy: { strategy: "lottery", drainThresholdPercent: 80 },
					accounts: [
						accountFixture({
							state: "hibernating",
							usage: { ...readingFixture, reason: "brand_new" },
						}),
					],
				},
			],
		});
		const provider = parsed.providers[0];
		expect(provider?.capabilities.accountPinning).toBe("none");
		expect(provider?.capabilities.poolStrategies).toEqual(["manual"]);
		expect(provider?.policy?.strategy).toBe("manual");
		expect(provider?.accounts[0]?.state).toBe("unavailable");
		expect(provider?.accounts[0]?.usage?.reason).toBe("error");
	});

	test("a reading from older Core without account fields still parses", () => {
		const parsed = providerUsageReadingSchema.parse({
			providerId: "acp:codex",
			available: true,
			windows: [],
			meters: [],
		});
		expect(parsed.accountId).toBeUndefined();
		expect(parsed.observedAt).toBeUndefined();
	});
});

describe("subscriptions fetchers", () => {
	function capture(body: unknown): string[] {
		const urls: string[] = [];
		globalThis.fetch = createFetchFixture((url) => {
			urls.push(url);
			return Promise.resolve(Response.json(body));
		});
		return urls;
	}

	test("fetchSubscriptionsSnapshot encodes provider and usage mode", async () => {
		const urls = capture(snapshotFixture);
		const snapshot = await fetchSubscriptionsSnapshot(target, {
			providerId: "claude-pro-max",
			usage: "force",
		});
		expect(snapshot.providers).toHaveLength(1);
		expect(urls[0]).toBe(
			"http://127.0.0.1:7980/api/usage/subscriptions?provider=claude-pro-max&usage=force"
		);
		await fetchSubscriptionsSnapshot(target);
		expect(urls[1]).toBe("http://127.0.0.1:7980/api/usage/subscriptions");
	});

	test("fetchProviderUsageReading encodes the path, account and refresh", async () => {
		const urls = capture(readingFixture);
		const reading = await fetchProviderUsageReading(target, {
			providerId: "acp:codex",
		});
		expect(reading.accountId).toBe("acct_1");
		expect(urls[0]).toBe(
			"http://127.0.0.1:7980/api/usage/subscriptions/acp%3Acodex/reading"
		);
		await fetchProviderUsageReading(target, {
			providerId: "claude-pro-max",
			accountId: "acct_2",
			refresh: true,
		});
		expect(urls[1]).toBe(
			"http://127.0.0.1:7980/api/usage/subscriptions/claude-pro-max/reading?account=acct_2&refresh=1"
		);
		await fetchProviderUsageReading(target, {
			providerId: "claude-pro-max",
			refresh: "force",
		});
		expect(urls[2]).toEndWith("/reading?refresh=force");
	});

	test("a malformed reading is rejected", async () => {
		capture({ providerId: "claude-pro-max" });
		await expect(
			fetchProviderUsageReading(target, { providerId: "claude-pro-max" })
		).rejects.toThrow();
	});
});

describe("query keys and predicates", () => {
	test("keys are scoped by node and credentials", () => {
		expect(subscriptionQueryKeys.all(target)).toEqual([
			"subscriptions",
			target.url,
			"t",
			null,
		]);
		expect(subscriptionQueryKeys.snapshot({ url: "u", token: null })).toEqual([
			"subscriptions",
			"u",
			null,
			null,
			"*",
		]);
		expect(
			subscriptionQueryKeys.reading(target, "claude-pro-max", null)
		).toEqual([
			"provider-account-usage",
			target.url,
			"t",
			null,
			"claude-pro-max",
			"@active",
		]);
	});

	test("hasReadableAccountWindows needs a valid account-wide window", () => {
		const reading = providerUsageReadingSchema.parse(readingFixture);
		expect(hasReadableAccountWindows(reading)).toBe(true);
		const modelOnly: ProviderUsageReading = {
			...reading,
			windows: reading.windows.map((w) => ({ ...w, model: "opus" })),
		};
		expect(hasReadableAccountWindows(modelOnly)).toBe(false);
		const outOfRange: ProviderUsageReading = {
			...reading,
			windows: reading.windows.map((w) => ({ ...w, usedPercent: 140 })),
		};
		expect(hasReadableAccountWindows(outOfRange)).toBe(false);
		expect(hasReadableAccountWindows({ ...reading, available: false })).toBe(
			false
		);
	});

	test("eligiblePoolAccounts drops disabled, reauth and unsupported accounts", () => {
		const provider: SubscriptionProvider | undefined =
			subscriptionsSnapshotSchema.parse(snapshotFixture).providers[0];
		expect(provider).toBeDefined();
		if (!provider) {
			return;
		}
		expect(eligiblePoolAccounts(provider).map((a) => a.accountId)).toEqual([
			"acct_1",
			"acct_5",
		]);
	});
});
