import { describe, expect, test } from "bun:test";
import type { AccountPool } from "@/src/lib/api/account-pools.ts";
import type {
	ProviderUsageWindow,
	SubscriptionAccount,
	SubscriptionProvider,
	UsageSnapshot,
} from "@/src/lib/api/usage.ts";
import {
	buildUsageRailSources,
	limitedAccounts,
	type RailAgentUsage,
	shortWindowLabel,
} from "./usage-rail-sources.ts";

const FIVE_HOURS = 5 * 3600;
const WEEK = 7 * 24 * 3600;

function window(
	label: string,
	usedPercent: number,
	windowSeconds: number,
	extra: Partial<ProviderUsageWindow> = {}
): ProviderUsageWindow {
	return {
		targetId: `window:${label}::${windowSeconds}`,
		label,
		scope: "account",
		usedPercent,
		remainingPercent: 100 - usedPercent,
		windowSeconds,
		window: windowSeconds === FIVE_HOURS ? "5h" : "7d",
		...extra,
	};
}

function account(
	accountId: string,
	windows: ProviderUsageWindow[] | null,
	extra: Partial<SubscriptionAccount> = {}
): SubscriptionAccount {
	return {
		accountId,
		label: `${accountId}@example.test`,
		kind: "oauth",
		active: false,
		gatewayActive: false,
		needsReauth: false,
		updatedAt: 0,
		poolEnabled: true,
		state: "ok",
		usage: windows
			? {
					providerId: "p",
					available: true,
					reason: null,
					windows,
					meters: [],
				}
			: null,
		...extra,
	};
}

function provider(
	providerId: string,
	accounts: SubscriptionAccount[],
	extra: Partial<SubscriptionProvider> = {}
): SubscriptionProvider {
	return {
		providerId,
		label: `${providerId} label`,
		kind: "subscription",
		managed: false,
		capabilities: {
			accountUsage: true,
			accountPing: false,
			accountPinning: "none",
			poolStrategies: [],
			quotaObservations: false,
		},
		accounts,
		...extra,
	};
}

function snapshot(extra: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return {
		agentId: "acp:claude",
		available: true,
		engine: "claude",
		extraUsageUsd: null,
		meters: [],
		plan: null,
		reason: null,
		retryAfterSeconds: null,
		windows: [
			{
				label: "Weekly",
				model: null,
				resetsAt: null,
				usedPercent: 30,
				windowSeconds: WEEK,
			},
			{
				label: "Session",
				model: null,
				resetsAt: null,
				usedPercent: 80,
				windowSeconds: FIVE_HOURS,
			},
		],
		...extra,
	};
}

function agent(
	id: string,
	usage: UsageSnapshot | null,
	name = id
): RailAgentUsage {
	return { avatarUrl: null, engine: "claude", id, name, snapshot: usage };
}

const claude = provider("claude-pro-max", [
	account("a1", [
		window("Session", 40, FIVE_HOURS),
		window("Weekly", 10, WEEK),
	]),
	account("a2", [
		window("Session", 100, FIVE_HOURS, {
			resetsAt: "2026-11-25T18:00:00Z",
		}),
		window("Weekly", 20, WEEK),
	]),
	account("a3", [window("Weekly", 60, WEEK)]),
]);
const codex = provider("openai-codex", [
	account("c1", [window("Session", 25, FIVE_HOURS)]),
]);

const teamPool: AccountPool = {
	id: "pool-1",
	name: "Team",
	accounts: [
		{ providerId: "claude-pro-max", accountId: "a1" },
		{ providerId: "claude-pro-max", accountId: "a2" },
	],
};

describe("the sources of the usage rings", () => {
	test("nothing to read gives no ring", () => {
		expect(
			buildUsageRailSources({ agents: [], pools: [], providers: [] })
		).toEqual([]);
		expect(
			buildUsageRailSources({
				agents: [agent("acp:claude", null)],
				pools: [{ id: "p", name: "Empty", accounts: [] }],
				providers: [provider("x", [account("a", null)])],
			})
		).toEqual([]);
	});

	test("a pool is one ring, and its accounts leave their provider's ring", () => {
		const sources = buildUsageRailSources({
			agents: [],
			pools: [teamPool],
			providers: [claude, codex],
		});
		expect(sources.map((source) => source.id)).toEqual([
			"pool:pool-1",
			"provider:claude-pro-max",
			"provider:openai-codex",
		]);
		const [pool, rest] = sources;
		expect(pool?.kind).toBe("pool");
		expect(pool?.name).toBe("Team");
		expect(pool?.accounts.map((entry) => entry.id)).toEqual(["a1", "a2"]);
		// a1 has 60 left in its tightest window, a2 has 0: the pool has 30.
		expect(pool?.readable).toBe(2);
		expect(pool?.leftPercent).toBe(30);
		expect(pool?.tracks).toEqual([{ label: null, usedPercent: 70 }]);
		expect(pool?.logo).toEqual({
			kind: "provider",
			key: "claude-pro-max claude-pro-max label",
		});
		// The account outside every pool is what Auto still rotates over.
		expect(rest?.accounts.map((entry) => entry.id)).toEqual(["a3"]);
		expect(rest?.leftPercent).toBe(40);
	});

	test("the limited account of a pool is marked with its reset", () => {
		const [pool] = buildUsageRailSources({
			agents: [],
			pools: [teamPool],
			providers: [claude],
		});
		expect(pool).toBeDefined();
		const limited = limitedAccounts(pool as NonNullable<typeof pool>);
		expect(limited.map((entry) => entry.id)).toEqual(["a2"]);
		expect(limited[0]?.limitedUntil).toBe("2026-11-25T18:00:00Z");
		expect(limited[0]?.leftPercent).toBe(0);
	});

	test("one account draws two tracks: the longest window outside, the shortest inside", () => {
		const [source] = buildUsageRailSources({
			agents: [],
			pools: [],
			providers: [
				provider("claude-pro-max", [
					account("a1", [
						window("Weekly", 10, WEEK),
						window("Session", 40, FIVE_HOURS),
						window("Opus", 95, WEEK, { model: "opus", scope: "model" }),
					]),
				]),
			],
		});
		expect(source?.tracks).toEqual([
			{ label: "7d", usedPercent: 10 },
			{ label: "5h", usedPercent: 40 },
		]);
		// A model window is listed last and never decides what is left.
		expect(source?.accounts[0]?.windows.map((entry) => entry.model)).toEqual([
			null,
			null,
			"opus",
		]);
		expect(source?.leftPercent).toBe(60);
		expect(source?.accounts[0]?.limited).toBe(false);
	});

	test("an account Core will not route to has no number, even with a cached reading", () => {
		const sources = buildUsageRailSources({
			agents: [],
			pools: [],
			providers: [
				provider("claude-pro-max", [
					account("ok", [window("Session", 50, FIVE_HOURS)]),
					account("stale", [window("Session", 0, FIVE_HOURS)], {
						state: "needs_reauth",
					}),
					account("off", [window("Session", 0, FIVE_HOURS)], {
						state: "pool_disabled",
					}),
					account("cold", null, { state: "pending" }),
				]),
			],
		});
		expect(sources).toHaveLength(1);
		expect(sources[0]?.readable).toBe(1);
		expect(sources[0]?.leftPercent).toBe(50);
		expect(sources[0]?.accounts.map((entry) => entry.state)).toEqual([
			"ok",
			"needs_reauth",
			"pool_disabled",
			"pending",
		]);
	});

	test("managed and API credit providers have no ring", () => {
		const windows = [window("Session", 50, FIVE_HOURS)];
		expect(
			buildUsageRailSources({
				agents: [],
				pools: [],
				providers: [
					provider("ryu", [account("m", windows)], { managed: true }),
					provider("openrouter", [account("k", windows)], {
						kind: "api_credits",
					}),
				],
			})
		).toEqual([]);
	});

	test("a pool across two providers shows its initial, and an unknown member has no number", () => {
		const [pool] = buildUsageRailSources({
			agents: [],
			pools: [
				{
					id: "mixed",
					name: " mixed pool",
					accounts: [
						{ providerId: "claude-pro-max", accountId: "a1" },
						{ providerId: "openai-codex", accountId: "c1" },
						{ providerId: "openrouter", accountId: "key" },
					],
				},
			],
			providers: [claude, codex],
		});
		expect(pool?.logo).toEqual({ kind: "initial", text: "m" });
		expect(pool?.readable).toBe(2);
		// a1 has 60 left, c1 has 75.
		expect(pool?.leftPercent).toBe(67.5);
		expect(pool?.accounts[2]?.state).toBe("unsupported");
	});

	test("an agent on its own CLI sign-in keeps one ring per sign-in", () => {
		const sources = buildUsageRailSources({
			agents: [
				agent("acp:claude", snapshot(), "Claude Code"),
				agent("my-claude-bot", snapshot(), "My bot"),
				agent(
					"acp:codex",
					snapshot({ agentId: "acp:codex", engine: "codex", windows: [] })
				),
				agent("acp:glm", snapshot({ available: false, engine: "glm" })),
			],
			pools: [],
			providers: [],
		});
		expect(sources.map((source) => source.id)).toEqual(["agent:claude"]);
		expect(sources[0]?.name).toBe("Claude Code");
		expect(sources[0]?.tracks).toEqual([
			{ label: "7d", usedPercent: 30 },
			{ label: "5h", usedPercent: 80 },
		]);
		expect(sources[0]?.leftPercent).toBe(20);
	});

	test("an agent that reads a saved Ryu account has no ring of its own", () => {
		expect(
			buildUsageRailSources({
				agents: [
					agent(
						"acp:claude",
						snapshot({ accountId: "a1", providerId: "claude-pro-max" })
					),
				],
				pools: [],
				providers: [],
			})
		).toEqual([]);
	});
});

describe("short window labels", () => {
	test("Core's own short label wins", () => {
		expect(
			shortWindowLabel({ label: "Session", usedPercent: 0, window: "5h" })
		).toBe("5h");
	});

	test("the two rolling windows read as their length", () => {
		expect(
			shortWindowLabel({
				label: "Session",
				usedPercent: 0,
				windowSeconds: 3 * 3600,
			})
		).toBe("3h");
		expect(
			shortWindowLabel({ label: "Weekly", usedPercent: 0, windowSeconds: WEEK })
		).toBe("7d");
		expect(shortWindowLabel({ label: "Session", usedPercent: 0 })).toBe("5h");
		expect(shortWindowLabel({ label: "Weekly", usedPercent: 0 })).toBe("7d");
	});

	test("a vendor's own window keeps its name", () => {
		expect(
			shortWindowLabel({ label: "Sonnet", usedPercent: 0, windowSeconds: WEEK })
		).toBe("Sonnet");
	});
});
