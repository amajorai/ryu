// The rings at the side of the window read three things from Core: the
// subscriptions snapshot (providers, saved accounts, one reading each), the
// custom account pools, and the usage of each agent on its own CLI sign-in.
// These tests drive the hook against an in-memory copy of those routes and
// check the sources it builds and the requests it does and does not send.

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { AccountPoolCatalog } from "@/src/lib/api/account-pools.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { PiCatalog } from "@/src/lib/api/pi-config.ts";
import type { UsageSnapshot } from "@/src/lib/api/usage.ts";
import type { UsageRailSource } from "@/src/lib/usage-rail/usage-rail-sources.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const target: ApiTarget = {
	url: "https://usage-rail-sources.fixture",
	token: "usage-rail-token",
	userJwt: "usage-rail-user",
};

type RailAgent = Pick<
	AgentSummary,
	| "avatarGlyph"
	| "avatarUrl"
	| "builtIn"
	| "engine"
	| "id"
	| "installed"
	| "name"
>;
type SavedLogins = Pick<PiCatalog, "providers"> | null;

// The active node, the list of agents and the provider catalog each have a
// hook and tests of their own. Bun's module mocks are process-wide and this
// file runs in its own process.
let agents: RailAgent[];
let piCatalog: SavedLogins;
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => target,
}));
mock.module("@/src/hooks/useAgents.ts", () => ({
	useAgents: () => ({ agents }),
}));
mock.module("@/src/hooks/usePiConfig.ts", () => ({
	usePiConfig: () => ({ catalog: piCatalog }),
}));

const { createRoot } = await import("react-dom/client");
const { useProductModeStore } = await import("@/src/lib/product-mode.ts");
const { resetUsageBarPrefs, setUsageBarPrefs } = await import(
	"./useUsageBarPrefs.ts"
);
const { useUsageRailSources } = await import("./useUsageRailSources.ts");

const SUBSCRIPTIONS = "/api/usage/subscriptions?usage=refresh";
const POOLS = "/api/pi-config/providers/account-pools";
const CLAUDE_USAGE = "/api/agents/acp%3Aclaude/usage";
const CODEX_USAGE = "/api/agents/acp%3Acodex/usage";
const FIVE_HOURS = 5 * 3600;
const WEEK = 7 * 24 * 3600;

function usageWindow(label: "Session" | "Weekly", usedPercent: number) {
	const windowSeconds = label === "Session" ? FIVE_HOURS : WEEK;
	return {
		label,
		remainingPercent: 100 - usedPercent,
		resetsAt: "2026-11-26T09:30:00.000Z",
		scope: "account",
		targetId: `window:${label}::${windowSeconds}`,
		usedPercent,
		window: label === "Session" ? "5h" : "7d",
		windowSeconds,
	};
}

function savedAccount(
	providerId: string,
	accountId: string,
	windows: ReturnType<typeof usageWindow>[]
) {
	return {
		accountId,
		active: false,
		gatewayActive: false,
		kind: "oauth",
		label: `${accountId}@example.test`,
		needsReauth: false,
		poolEnabled: true,
		state: "ok",
		updatedAt: 0,
		usage: { available: true, meters: [], providerId, windows },
	};
}

function subscriptionProvider(
	providerId: string,
	label: string,
	accounts: ReturnType<typeof savedAccount>[],
	managed = false
) {
	return {
		accounts,
		capabilities: {
			accountPing: false,
			accountPinning: "none",
			accountUsage: true,
			poolStrategies: ["manual"],
			quotaObservations: false,
		},
		kind: "subscription",
		label,
		managed,
		providerId,
	};
}

/** Core's snake_case answer of the agent usage route. */
function agentUsage(
	agentId: string,
	engine: string,
	extra: Record<string, unknown> = {}
) {
	return {
		account_id: null,
		agent_id: agentId,
		available: true,
		engine,
		meters: [],
		plan: "Max",
		reason: null,
		windows: [
			{
				label: "Session",
				resets_at: "2026-11-26T09:30:00.000Z",
				used_percent: 20,
				window_seconds: FIVE_HOURS,
			},
			{
				label: "Weekly",
				resets_at: "2026-11-30T00:00:00.000Z",
				used_percent: 55,
				window_seconds: WEEK,
			},
		],
		...extra,
	};
}

function agent(id: string, name: string, extra: Partial<RailAgent> = {}) {
	return {
		avatarGlyph: null,
		avatarUrl: null,
		builtIn: true,
		engine: id.replace("acp:", ""),
		id,
		installed: true,
		name,
		...extra,
	};
}

/** A catalog with one saved subscription sign-in, which opens the owner routes. */
function savedLogins(accounts = 1, managed = false): SavedLogins {
	return {
		providers: [
			{
				accounts: Array.from({ length: accounts }, (_, index) => ({
					accountId: `saved-${index}`,
					active: index === 0,
					gatewayActive: false,
					kind: "oauth",
					label: `saved-${index}`,
					updatedAt: 0,
				})),
				api: "anthropic-messages",
				authEnv: "",
				authKind: "subscription",
				configured: true,
				custom: false,
				id: "claude-pro-max",
				label: "Claude Pro/Max",
				managed,
				routing: "direct",
				suggestedModels: [],
			},
		],
	} as SavedLogins;
}

const originalFetch = globalThis.fetch;
let providers: ReturnType<typeof subscriptionProvider>[];
let pools: AccountPoolCatalog;
let poolStatus: number;
/** Set to hold the answer of the pool route until the test lets it go. */
let poolGate: Promise<void> | null;
let usageByAgent: Record<string, ReturnType<typeof agentUsage>>;
let paths: string[];
let seen: UsageRailSource[];
let renders: number;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

function Reader() {
	seen = useUsageRailSources();
	renders += 1;
	return null;
}

async function mount(): Promise<void> {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<Reader />
			</QueryClientProvider>
		)
	);
}

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(
				`The sources did not settle: ${JSON.stringify(ids())} after ${JSON.stringify(paths)}`
			);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}

/** Lets every request that is going to be sent go out and come back. */
async function quiet(): Promise<void> {
	await act(async () => {
		await Bun.sleep(60);
	});
}

function ids(): string[] {
	return seen.map((source) => source.id);
}

function sourceById(id: string): UsageRailSource {
	const source = seen.find((entry) => entry.id === id);
	if (!source) {
		throw new Error(`No source ${id} in ${JSON.stringify(ids())}`);
	}
	return source;
}

function asked(path: string): number {
	return paths.filter((entry) => entry === path).length;
}

beforeEach(() => {
	providers = [
		subscriptionProvider("claude-pro-max", "Claude Pro/Max", [
			savedAccount("claude-pro-max", "work", [
				usageWindow("Session", 40),
				usageWindow("Weekly", 10),
			]),
			savedAccount("claude-pro-max", "home", [usageWindow("Session", 100)]),
			savedAccount("claude-pro-max", "spare", [usageWindow("Weekly", 60)]),
		]),
		subscriptionProvider("openai-codex", "ChatGPT", [
			savedAccount("openai-codex", "c1", [usageWindow("Session", 25)]),
		]),
	];
	pools = {
		agents: {},
		maxPoolAccounts: 200,
		maxPools: 50,
		pools: [
			{
				accounts: [
					{ accountId: "work", providerId: "claude-pro-max" },
					{ accountId: "home", providerId: "claude-pro-max" },
				],
				id: "pool-1",
				name: "Team",
			},
		],
	};
	poolStatus = 200;
	poolGate = null;
	agents = [
		agent("acp:claude", "Claude Code"),
		agent("acp:codex", "Codex"),
		// Not installed, and an engine that reports no subscription window.
		agent("acp:gemini", "Gemini CLI", { installed: false }),
		agent("acp:aider", "Aider"),
	];
	usageByAgent = {
		"acp:claude": agentUsage("acp:claude", "claude"),
		// Codex runs on the saved account c1: that account's ring shows it.
		"acp:codex": agentUsage("acp:codex", "codex", { account_id: "c1" }),
	};
	piCatalog = savedLogins();
	paths = [];
	seen = [];
	renders = 0;
	useProductModeStore.setState({
		consoleAccess: true,
		requestedMode: "console",
	});
	client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			const path = `${url.pathname}${url.search}`;
			paths.push(path);
			if (path === SUBSCRIPTIONS) {
				return Response.json({
					generatedAt: "2026-11-26T02:00:00.000Z",
					providers,
					version: 1,
				});
			}
			if (path === POOLS) {
				await poolGate;
				return poolStatus === 200
					? Response.json(pools)
					: Response.json({ error: "no such route" }, { status: poolStatus });
			}
			const agentId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
			const usage = usageByAgent[agentId];
			return usage
				? Response.json(usage)
				: Response.json({ error: `unexpected ${path}` }, { status: 500 });
		},
		{ preconnect: originalFetch.preconnect }
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	client.clear();
	act(() => resetUsageBarPrefs());
	localStorage.clear();
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

test("builds one source per pool, per provider with accounts outside every pool, and per agent on its own sign-in", async () => {
	await mount();
	await until(() => seen.length === 4);
	expect(ids()).toEqual([
		"pool:pool-1",
		"provider:claude-pro-max",
		"provider:openai-codex",
		"agent:claude",
	]);

	// The pool holds two accounts: 60% and 0% left in their tightest windows.
	const pool = sourceById("pool:pool-1");
	expect(pool.kind).toBe("pool");
	expect(pool.name).toBe("Team");
	expect(pool.accounts.map((entry) => entry.id)).toEqual(["work", "home"]);
	expect(pool.accounts.map((entry) => entry.label)).toEqual([
		"work@example.test",
		"home@example.test",
	]);
	expect(pool.leftPercent).toBe(30);
	expect(pool.accounts.map((entry) => entry.limited)).toEqual([false, true]);
	expect(pool.logo).toEqual({
		kind: "provider",
		key: "claude-pro-max Claude Pro/Max",
	});

	// The pooled accounts left their provider's ring: only the spare one stays.
	const claude = sourceById("provider:claude-pro-max");
	expect(claude.name).toBe("Claude Pro/Max");
	expect(claude.accounts.map((entry) => entry.id)).toEqual(["spare"]);
	expect(claude.leftPercent).toBe(40);
	expect(sourceById("provider:openai-codex").leftPercent).toBe(75);

	// The agent on its own CLI sign-in: the longest window outside, the shortest inside.
	const own = sourceById("agent:claude");
	expect(own.kind).toBe("agent");
	expect(own.name).toBe("Claude Code");
	expect(own.tracks).toEqual([
		{ label: "7d", usedPercent: 55 },
		{ label: "5h", usedPercent: 20 },
	]);
	expect(own.leftPercent).toBe(45);
	expect(own.logo).toEqual({
		avatarUrl: null,
		engine: "claude",
		glyph: null,
		kind: "agent",
	});
});

test("an agent whose reading came from a saved account gets no ring of its own", async () => {
	await mount();
	await until(() => seen.length === 4);
	expect(asked(CODEX_USAGE)).toBe(1);
	expect(ids()).not.toContain("agent:codex");
});

test("asks each route once, and only for installed agents whose engine reports usage", async () => {
	await mount();
	await until(() => seen.length === 4);
	await quiet();
	expect([...paths].sort()).toEqual(
		[CLAUDE_USAGE, CODEX_USAGE, POOLS, SUBSCRIPTIONS].sort()
	);
});

test("two agents on one engine read one sign-in and share a ring", async () => {
	agents = [
		agent("acp:claude", "Claude Code"),
		agent("acp:claude-review", "Reviewer", { engine: "claude" }),
	];
	usageByAgent["acp:claude-review"] = agentUsage("acp:claude-review", "claude");
	piCatalog = savedLogins(0);
	await mount();
	await until(() => asked("/api/agents/acp%3Aclaude-review/usage") === 1);
	await quiet();
	expect(ids()).toEqual(["agent:claude"]);
	expect(sourceById("agent:claude").name).toBe("Claude Code");
});

test("an agent that is signed out has no ring", async () => {
	usageByAgent["acp:claude"] = agentUsage("acp:claude", "claude", {
		available: false,
		reason: "not_logged_in",
		windows: [],
	});
	await mount();
	await until(() => seen.length === 3);
	await quiet();
	expect(ids()).toEqual([
		"pool:pool-1",
		"provider:claude-pro-max",
		"provider:openai-codex",
	]);
});

test("a node with no saved subscription sign-in is not asked for accounts or pools", async () => {
	piCatalog = savedLogins(0);
	await mount();
	await until(() => seen.length === 1);
	await quiet();
	expect(ids()).toEqual(["agent:claude"]);
	expect(asked(SUBSCRIPTIONS)).toBe(0);
	expect(asked(POOLS)).toBe(0);
});

test("the owner routes wait for the provider catalog, and a Ryu managed plan does not open them", async () => {
	piCatalog = null;
	await mount();
	await until(() => seen.length === 1);
	await quiet();
	expect(asked(SUBSCRIPTIONS)).toBe(0);

	piCatalog = savedLogins(2, true);
	await mount();
	await quiet();
	expect(asked(SUBSCRIPTIONS)).toBe(0);
	expect(asked(POOLS)).toBe(0);

	piCatalog = savedLogins(2);
	await mount();
	await until(() => seen.length === 4);
	expect(asked(SUBSCRIPTIONS)).toBe(1);
	expect(asked(POOLS)).toBe(1);
});

test("with Show usage in the sidebar off nothing is asked and nothing shows", async () => {
	act(() => setUsageBarPrefs({ sidebar: false }));
	await mount();
	await quiet();
	expect(seen).toEqual([]);
	expect(paths).toEqual([]);

	// Turning it on asks Core and brings the rings.
	await act(() => setUsageBarPrefs({ sidebar: true }));
	await until(() => seen.length === 4);

	// Turning it off again empties the strip at once.
	await act(() => setUsageBarPrefs({ sidebar: false }));
	expect(seen).toEqual([]);
});

test("the bot product shows no rings and asks nothing", async () => {
	useProductModeStore.setState({ requestedMode: "bot" });
	await mount();
	await quiet();
	expect(seen).toEqual([]);
	expect(paths).toEqual([]);
});

test("a remembered Console choice without access is the bot product: no rings", async () => {
	useProductModeStore.setState({
		consoleAccess: false,
		requestedMode: "console",
	});
	await mount();
	await quiet();
	expect(seen).toEqual([]);
	expect(paths).toEqual([]);

	await act(() => useProductModeStore.setState({ consoleAccess: true }));
	await until(() => seen.length === 4);
});

test("an older Core with no pool routes is asked once and the providers show alone", async () => {
	poolStatus = 404;
	await mount();
	await until(() => seen.length === 3);
	await quiet();
	expect(ids()).toEqual([
		"provider:claude-pro-max",
		"provider:openai-codex",
		"agent:claude",
	]);
	// With no pool every saved account stays on its provider's ring.
	const claude = sourceById("provider:claude-pro-max");
	expect(claude.accounts.map((entry) => entry.id)).toEqual([
		"work",
		"home",
		"spare",
	]);
	expect(claude.readable).toBe(3);
	// The mean of 60, 0 and 40 left.
	expect(Math.round(claude.leftPercent)).toBe(33);
	expect(asked(POOLS)).toBe(1);
});

test("the provider rings wait for the pools, so an account never shows in two places", async () => {
	let release: () => void = () => undefined;
	poolGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await mount();
	await until(() => asked(SUBSCRIPTIONS) === 1 && seen.length === 1);
	await quiet();
	// The accounts are known, the pools are not: only the agent's ring shows.
	expect(ids()).toEqual(["agent:claude"]);

	release();
	await until(() => seen.length === 4);
	expect(sourceById("provider:claude-pro-max").accounts).toHaveLength(1);
});

test("a pool with no readable account has no ring", async () => {
	pools = {
		...pools,
		pools: [
			...pools.pools,
			{
				accounts: [{ accountId: "gone", providerId: "claude-pro-max" }],
				id: "pool-2",
				name: "Empty",
			},
		],
	};
	await mount();
	await until(() => seen.length === 4);
	expect(ids()).not.toContain("pool:pool-2");
});

test("a reading another surface already holds is used without a second request", async () => {
	// The key the picker's provider meter and `useAgentUsage` read.
	const held: UsageSnapshot = {
		accountId: null,
		agentId: "acp:claude",
		available: true,
		engine: "claude",
		extraUsageUsd: null,
		meters: [],
		plan: "Max",
		reason: null,
		retryAfterSeconds: null,
		windows: [
			{
				label: "Session",
				model: null,
				resetsAt: null,
				usedPercent: 90,
				windowSeconds: FIVE_HOURS,
			},
		],
	};
	client.setQueryData(
		["agent-usage", target.url, target.token, target.userJwt, "acp:claude"],
		held
	);
	await mount();
	await until(() => seen.length === 4);
	await quiet();
	expect(asked(CLAUDE_USAGE)).toBe(0);
	expect(sourceById("agent:claude").leftPercent).toBe(10);
});

test("a render with nothing new keeps the same list", async () => {
	await mount();
	await until(() => seen.length === 4);
	await quiet();
	const before = seen;
	const rendered = renders;
	await mount();
	expect(renders).toBeGreaterThan(rendered);
	expect(seen).toBe(before);
});
