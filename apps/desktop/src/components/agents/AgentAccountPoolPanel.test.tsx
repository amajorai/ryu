// The agent's pool picker reads the same pool list as the settings page and
// shows which pool, if any, the agent is limited to. On a Core with Auto it
// also offers Auto and the agent's ordered backup models.

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { AccountPoolCatalog } from "@/src/lib/api/account-pools.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const target: ApiTarget = {
	url: "https://agent-account-pool.fixture",
	token: "agent-pool-token",
	userJwt: "account-pools-user",
};
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => target,
}));
const { createRoot } = await import("react-dom/client");
const { AgentAccountPoolPanel } = await import("./AgentAccountPoolPanel.tsx");

const originalFetch = globalThis.fetch;
const piCatalog = {
	apiTypes: [],
	providers: [
		{
			api: "anthropic-messages",
			authEnv: "",
			authKind: "subscription",
			configured: true,
			custom: false,
			id: "claude-pro-max",
			label: "Claude (Pro/Max)",
			routing: "direct",
			suggestedModels: ["claude-opus-4-7"],
		},
	],
	thinkingLevels: [],
};
let catalog: AccountPoolCatalog;
let status: number;
let paths: string[];
let writes: { body: unknown; path: string }[];
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(`Pool panel did not settle: ${container.textContent}`);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}

async function mount(agentId: string): Promise<void> {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<AgentAccountPoolPanel agentId={agentId} />
			</QueryClientProvider>
		)
	);
	await until(() => paths.length > 0);
	await until(
		() =>
			container.querySelector("button") !== null ||
			container.textContent?.includes("No account pools yet.") === true ||
			container.textContent?.includes("Could not load") === true
	);
}

beforeEach(() => {
	catalog = {
		agents: { security: "pool-1" },
		maxPoolAccounts: 200,
		maxPools: 50,
		pools: [
			{
				accounts: [{ accountId: "work", providerId: "claude-pro-max" }],
				id: "pool-1",
				name: "Mythos",
			},
			{ accounts: [], id: "pool-2", name: "General" },
		],
	};
	status = 200;
	paths = [];
	writes = [];
	client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			const path = new URL(String(input)).pathname;
			paths.push(path);
			if (init?.method === "PUT") {
				const body = JSON.parse(String(init.body)) as Record<string, unknown>;
				writes.push({ body, path });
				return Promise.resolve(
					Response.json({
						agentId: "security",
						backups: body.backups ?? [],
						mode: body.mode ?? "none",
						poolId: body.poolId ?? null,
					})
				);
			}
			if (path === "/api/pi-config/catalog") {
				return Promise.resolve(Response.json(piCatalog));
			}
			return Promise.resolve(
				status === 200
					? Response.json(catalog)
					: Response.json({ error: "down" }, { status })
			);
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
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

test("shows the pool the agent is limited to", async () => {
	await mount("security");
	expect(paths).toEqual(["/api/pi-config/providers/account-pools"]);
	expect(container.textContent).toContain("Account pool");
	expect(container.textContent).toContain("Mythos");
});

test("an agent with no pool uses all accounts", async () => {
	await mount("writer");
	expect(container.textContent).toContain("All accounts (no pool)");
});

test("points to the provider settings when no pool exists", async () => {
	catalog = { ...catalog, agents: {}, pools: [] };
	await mount("security");
	expect(container.textContent).toContain(
		"No account pools yet. Create one in the LLM provider settings."
	);
	expect(container.querySelector('[role="combobox"]')).toBeNull();
});

test("is left out on a node whose Core has no account pools", async () => {
	status = 404;
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<AgentAccountPoolPanel agentId="security" />
			</QueryClientProvider>
		)
	);
	await until(() => paths.length > 0 && container.textContent === "");
});

test("says so when the pools cannot be read", async () => {
	status = 500;
	await mount("security");
	expect(container.textContent).toContain("Could not load account pools.");
});

/** Core with Auto: the same catalog plus Auto, backups and their limit. */
function withAuto(extra: Partial<AccountPoolCatalog> = {}): void {
	catalog = { ...catalog, auto: [], backups: {}, maxBackups: 8, ...extra };
}

test("a Core without Auto shows no Auto choice and no backup list", async () => {
	await mount("writer");
	expect(container.textContent).not.toContain("Auto (try every account)");
	expect(container.textContent).not.toContain("Backup models");
});

test("an agent on Auto shows Auto and how it works", async () => {
	withAuto({ agents: {}, auto: ["security"] });
	await mount("security");
	expect(container.textContent).toContain("Auto (try every account)");
	expect(container.textContent).toContain(
		"Each request tries the saved accounts of its provider one after another."
	);
	expect(container.textContent).toContain("No backup models yet.");
});

test("Auto is offered even before any pool exists", async () => {
	withAuto({ agents: {}, pools: [] });
	await mount("writer");
	expect(container.textContent).not.toContain("No account pools yet.");
	expect(container.textContent).toContain("All accounts (no pool)");
	expect(container.textContent).toContain("Backup models");
});

test("a backup change is saved with the agent's mode and pool", async () => {
	withAuto({
		backups: {
			security: [
				{ model: "claude-opus-4-7", providerId: "claude-pro-max" },
				{ model: "claude-sonnet-4-6", providerId: "claude-pro-max" },
			],
		},
	});
	await mount("security");
	expect(container.textContent).toContain("1. claude-opus-4-7");
	const down = container.querySelector<HTMLButtonElement>(
		'button[aria-label="Move claude-opus-4-7 down"]'
	);
	if (!down) {
		throw new Error(`move button absent: ${container.textContent}`);
	}
	await act(async () => down.click());
	await until(() => writes.length > 0);
	expect(writes).toEqual([
		{
			body: {
				backups: [
					{ model: "claude-sonnet-4-6", providerId: "claude-pro-max" },
					{ model: "claude-opus-4-7", providerId: "claude-pro-max" },
				],
				mode: "pool",
				poolId: "pool-1",
			},
			path: "/api/pi-config/providers/account-pools/agents/security",
		},
	]);
});
