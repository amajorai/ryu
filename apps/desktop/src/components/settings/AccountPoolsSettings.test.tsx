// The pool section reads and writes Core's account pool routes. These tests
// drive it against an in-memory copy of those routes and check the requests it
// sends: a pool is a name and account ids, and a rename keeps the accounts.

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { AccountPoolCatalog } from "@/src/lib/api/account-pools.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { PiProvider } from "@/src/lib/api/pi-config.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const target: ApiTarget = {
	url: "https://account-pools-settings.fixture",
	token: "account-pools-token",
	userJwt: "account-pools-user",
};
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => target,
}));
const { createRoot } = await import("react-dom/client");
const { AccountPoolsSettings, poolAccountGroups } = await import(
	"./AccountPoolsSettings.tsx"
);

const BASE = "/api/pi-config/providers/account-pools";
const WORK = { accountId: "work", providerId: "claude-pro-max" };
const HOME = { accountId: "home", providerId: "claude-pro-max" };

function account(accountId: string, label: string, kind: string) {
	return {
		accountId,
		active: false,
		gatewayActive: false,
		kind,
		label,
		updatedAt: 0,
	};
}

const providers = [
	{
		accountRouting: {
			credentialKinds: ["oauth"],
			quotaObservations: true,
			strategies: ["manual", "round_robin"],
		},
		accounts: [
			account("work", "Work", "oauth"),
			account("home", "Home", "oauth"),
			account("key", "Key", "api_key"),
		],
		id: "claude-pro-max",
		label: "Claude Pro/Max",
	},
	{
		accounts: [account("solo", "Solo", "api_key")],
		id: "no-routing",
		label: "No routing",
	},
] as PiProvider[];

interface Call {
	body: unknown;
	method: string;
	path: string;
}

const originalFetch = globalThis.fetch;
let catalog: AccountPoolCatalog;
let calls: Call[];
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

function answer(call: Call): Response {
	if (call.path === BASE && call.method === "GET") {
		return Response.json(catalog);
	}
	if (call.path === BASE && call.method === "POST") {
		const body = call.body as { accounts: (typeof WORK)[]; name: string };
		const pool = { ...body, id: `pool-${catalog.pools.length + 1}` };
		catalog = { ...catalog, pools: [...catalog.pools, pool] };
		return Response.json(pool, { status: 201 });
	}
	const poolId = decodeURIComponent(call.path.slice(BASE.length + 1));
	const existing = catalog.pools.find((pool) => pool.id === poolId);
	if (!existing) {
		return Response.json({ error: "account pool not found" }, { status: 404 });
	}
	if (call.method === "PUT") {
		const pool = { ...existing, ...(call.body as object) };
		catalog = {
			...catalog,
			pools: catalog.pools.map((entry) => (entry.id === poolId ? pool : entry)),
		};
		return Response.json(pool);
	}
	catalog = {
		...catalog,
		agents: {},
		pools: catalog.pools.filter((pool) => pool.id !== poolId),
	};
	return new Response(null, { status: 204 });
}

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(`Pool section did not settle: ${container.textContent}`);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}

function button(label: string): HTMLButtonElement | undefined {
	return [...container.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === label
	);
}

async function click(label: string): Promise<void> {
	const found = button(label);
	if (!found) {
		throw new Error(`${label} button absent: ${container.textContent}`);
	}
	await act(async () => found.click());
}

async function typeName(value: string): Promise<void> {
	const input = container.querySelector<HTMLInputElement>("input[maxlength]");
	if (!input) {
		throw new Error("pool name input absent");
	}
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function mount(): Promise<void> {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<AccountPoolsSettings providers={providers} />
			</QueryClientProvider>
		)
	);
	await until(
		() =>
			container.querySelector("[data-pool-id]") !== null ||
			button("New pool") !== undefined
	);
}

beforeEach(() => {
	catalog = {
		agents: { security: "pool-1" },
		maxPoolAccounts: 200,
		maxPools: 50,
		pools: [{ accounts: [WORK, HOME], id: "pool-1", name: "Mythos" }],
	};
	calls = [];
	client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			const call: Call = {
				body: init?.body ? JSON.parse(String(init.body)) : null,
				method: init?.method ?? "GET",
				path: new URL(String(input)).pathname,
			};
			calls.push(call);
			return Promise.resolve(answer(call));
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

function writes(): Call[] {
	return calls.filter((call) => call.method !== "GET");
}

test("lists each pool with its account and agent counts", async () => {
	await mount();
	expect(container.textContent).toContain("Mythos");
	expect(container.textContent).toContain("Accounts: 2");
	expect(container.textContent).toContain("Agents: 1");
});

test("creates a pool from a name", async () => {
	await mount();
	await click("New pool");
	expect(button("Save pool")?.disabled).toBe(true);
	await typeName("  Research  ");
	await click("Save pool");
	await until(() => writes().length === 1);
	expect(writes()).toEqual([
		{ body: { accounts: [], name: "Research" }, method: "POST", path: BASE },
	]);
	await until(() => container.textContent?.includes("Research") === true);
	expect(button("Save pool")).toBeUndefined();
});

test("a rename keeps the accounts of the pool", async () => {
	await mount();
	await click("Edit");
	// Only accounts the provider can route are offered: two of the four.
	expect(container.textContent).toContain("Work");
	expect(container.textContent).toContain("Home");
	expect(container.textContent).not.toContain("Key");
	expect(container.textContent).not.toContain("Solo");
	await typeName("Security");
	await click("Save pool");
	await until(() => writes().length === 1);
	expect(writes()).toEqual([
		{
			body: { accounts: [WORK, HOME], name: "Security" },
			method: "PUT",
			path: `${BASE}/pool-1`,
		},
	]);
	await until(() => container.textContent?.includes("Security") === true);
});

test("deletes a pool only after the second click", async () => {
	await mount();
	await click("Delete");
	expect(writes()).toEqual([]);
	await click("Delete pool");
	await until(() => writes().length === 1);
	expect(writes()).toEqual([
		{ body: null, method: "DELETE", path: `${BASE}/pool-1` },
	]);
	await until(
		() => container.textContent?.includes("No account pools yet.") === true
	);
});

test("offers no new pool at Core's limit", async () => {
	catalog = { ...catalog, maxPools: 1 };
	await mount();
	expect(container.textContent).toContain("Mythos");
	expect(button("New pool")).toBeUndefined();
});

test("says so when the pools cannot be read", async () => {
	globalThis.fetch = Object.assign(
		() => Promise.resolve(Response.json({ error: "down" }, { status: 500 })),
		{ preconnect: originalFetch.preconnect }
	);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<AccountPoolsSettings providers={providers} />
			</QueryClientProvider>
		)
	);
	await until(
		() =>
			container.textContent?.includes("Could not load account pools.") === true
	);
});

test("is left out on a node whose Core has no account pools", async () => {
	let reads = 0;
	globalThis.fetch = Object.assign(
		() => {
			reads += 1;
			return Promise.resolve(
				Response.json({ error: "not found" }, { status: 404 })
			);
		},
		{ preconnect: originalFetch.preconnect }
	);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<AccountPoolsSettings providers={providers} />
			</QueryClientProvider>
		)
	);
	await until(() => reads > 0 && container.textContent === "");
});

test("a pool can hold only accounts its provider can route", () => {
	expect(poolAccountGroups(providers)).toEqual([
		{
			accounts: [
				expect.objectContaining({ accountId: "work" }),
				expect.objectContaining({ accountId: "home" }),
			],
			label: "Claude Pro/Max",
			providerId: "claude-pro-max",
		},
	]);
});
