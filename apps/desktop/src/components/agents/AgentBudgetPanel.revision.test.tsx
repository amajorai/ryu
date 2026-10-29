// The gateway replaces BudgetConfig as a unit, so a budget save is a
// read-modify-write. Each PUT must carry the revision it read; otherwise two
// concurrent saves (two admins, Desktop plus CLI) silently drop one cap.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const target: ApiTarget = {
	url: "https://budget-revision.fixture",
	token: "budget-token",
	userJwt: null,
};
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => target,
}));
mock.module("@/src/hooks/useGatewayConfigurable.ts", () => ({
	useGatewayConfigurable: () => true,
}));
const { createRoot } = await import("react-dom/client");
const { AgentBudgetPanel } = await import("./AgentBudgetPanel.tsx");

const REVISION = "a".repeat(64);
const originalFetch = globalThis.fetch;
let puts: Record<string, unknown>[] = [];
let root: Root;
let container: HTMLDivElement;

function gatewayConfig() {
	return {
		// A gateway always serves `auth` and `providers` beside its budgets.
		auth: { api_keys: [], require_auth: false },
		providers: {
			anthropic: null,
			core: null,
			genai: null,
			local: null,
			openai: null,
			openrouter: null,
		},
		budgets: {
			users: { "user-1": { action: "notify", limit: 5_000_000 } },
			agents: { "agent-1": { action: "stop", limit: 2_000_000 } },
			session: { action: "notify", limit: 0 },
		},
		configRevision: REVISION,
	};
}

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(`Budget panel did not settle: ${container.textContent}`);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}

async function click(label: string): Promise<void> {
	const button = [...container.querySelectorAll("button")].find((candidate) =>
		candidate.textContent?.includes(label)
	);
	if (!button) {
		throw new Error(`${label} button absent`);
	}
	await act(async () => button.click());
}

beforeEach(async () => {
	puts = [];
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname === "/api/gateway/config") {
				if (init?.method === "PUT") {
					puts.push(JSON.parse(String(init.body)));
					return Promise.resolve(Response.json({ ok: true }));
				}
				return Promise.resolve(Response.json(gatewayConfig()));
			}
			return Promise.resolve(
				Response.json({ error: "not in fixture" }, { status: 404 })
			);
		},
		{ preconnect: originalFetch.preconnect }
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root.render(<AgentBudgetPanel agentId="agent-1" />));
	await until(() => container.textContent?.includes("Remove cap") === true);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

test("saving an agent cap sends the revision it read with the whole budget set", async () => {
	await click("Save budget");
	await until(() => puts.length === 1);
	expect(puts[0]?.expectedRevision).toBe(REVISION);
	expect(puts[0]?.budgets).toMatchObject({
		users: { "user-1": { limit: 5_000_000 } },
		agents: { "agent-1": { limit: 2_000_000 } },
	});
});

test("removing an agent cap sends the revision it read", async () => {
	await click("Remove cap");
	await until(() => puts.length === 1);
	expect(puts[0]?.expectedRevision).toBe(REVISION);
	expect(puts[0]?.budgets).toEqual({
		users: { "user-1": { action: "notify", limit: 5_000_000 } },
		agents: {},
		session: { action: "notify", limit: 0 },
	});
});
