// The provider settings as a user meets them: one list, one page per row.
// These tests mount the real surface against an in-memory copy of Core's
// routes and check the list's grouping and summaries, the search, the section
// order of a page, where focus goes, and the pool menu of an account.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { AccountPoolCatalog } from "@/src/lib/api/account-pools.ts";
import type { Node } from "@/src/store/useNodeStore.ts";

const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { MemoryRouter } = await import("react-router-dom");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { requestSettingReveal, clearSettingReveal } = await import(
	"@/src/lib/settings-focus.ts"
);
const { SETTINGS_ENTRIES } = await import("@/src/lib/settings-index.ts");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { LlmProvidersSettings } = await import("../LlmProvidersSettings.tsx");

const node: Node = {
	name: "provider-pages-proof",
	url: "https://provider-pages.fixture:7980",
	token: "provider-pages-token",
	userJwt: null,
};

const POOLS = "/api/pi-config/providers/account-pools";
const WORK = { accountId: "work", providerId: "claude-pro-max" };
const HOME = { accountId: "home", providerId: "claude-pro-max" };

function account(accountId: string, label: string, extra: object = {}) {
	return {
		accountId,
		active: false,
		gatewayActive: false,
		kind: "oauth",
		label,
		updatedAt: 0,
		...extra,
	};
}

function provider(id: string, label: string, extra: object = {}) {
	return {
		api: "openai-completions",
		authEnv: "",
		authKind: "api-key",
		configured: false,
		custom: false,
		id,
		label,
		routing: "gateway",
		suggestedModels: [],
		supportsDiscovery: false,
		supportsOAuth: false,
		...extra,
	};
}

const PROVIDERS = [
	provider("gateway", "Ryu", {
		authKind: "none",
		configured: true,
		creditPool: "cloudflare",
		managed: true,
		routingLocked: true,
	}),
	provider("claude-pro-max", "Claude Pro/Max", {
		accountRouting: {
			credentialKinds: ["oauth"],
			quotaObservations: false,
			strategies: ["manual", "round_robin"],
		},
		accounts: [
			account("work", "work@example.com", { active: true }),
			account("home", "home@example.com", { needsReauth: true }),
		],
		api: "anthropic-messages",
		authKind: "subscription",
		configured: true,
		routing: "direct",
		supportsOAuth: true,
	}),
	provider("openai", "OpenAI", {
		accounts: [account("key-1", "Team key", { kind: "api_key" })],
		configured: true,
		suggestedModels: ["gpt-5.2"],
	}),
	provider("groq", "Groq"),
];

interface Call {
	body: unknown;
	method: string;
	path: string;
}
const originalFetch = globalThis.fetch;
const originalNodes = useNodeStore.getState();
const roots: Root[] = [];
let calls: Call[] = [];
let pools: AccountPoolCatalog;

function respond(call: Call): Response {
	if (call.path === "/api/pi-config/catalog") {
		return NativeResponse.json({
			apiTypes: ["openai-completions", "anthropic-messages"],
			providers: PROVIDERS,
			thinkingLevels: ["off"],
		});
	}
	if (call.path === "/api/pi-config" && call.method === "GET") {
		return NativeResponse.json({
			config: {
				configDir: "/tmp/pi",
				model: null,
				provider: "gateway",
				routing: "gateway",
				thinkingLevel: null,
			},
		});
	}
	if (call.method === "DELETE") {
		// As for a custom provider: the removed one leaves the catalog.
		return NativeResponse.json({
			apiTypes: [],
			providers: PROVIDERS.filter((p) => !call.path.endsWith(`/${p.id}`)),
			thinkingLevels: [],
		});
	}
	if (call.path === POOLS && call.method === "GET") {
		return NativeResponse.json(pools);
	}
	if (call.path.startsWith(`${POOLS}/`) && call.method === "PUT") {
		const poolId = decodeURIComponent(call.path.slice(POOLS.length + 1));
		const existing = pools.pools.find((pool) => pool.id === poolId);
		if (!existing) {
			return NativeResponse.json({ error: "not found" }, { status: 404 });
		}
		const saved = { ...existing, ...(call.body as object) };
		pools = {
			...pools,
			pools: pools.pools.map((pool) => (pool.id === poolId ? saved : pool)),
		};
		return NativeResponse.json(saved);
	}
	return NativeResponse.json({ error: "undeclared" }, { status: 404 });
}

beforeEach(() => {
	calls = [];
	pools = {
		agents: { security: "pool-1" },
		maxPoolAccounts: 200,
		maxPools: 50,
		pools: [
			{ accounts: [WORK, HOME], id: "pool-1", name: "Mythos" },
			{ accounts: [WORK], id: "pool-2", name: "Night shift" },
		],
	};
	localStorage.clear();
	clearSettingReveal();
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: node.name,
		nodes: [node],
	});
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const call: Call = {
				body: init?.body ? JSON.parse(String(init.body)) : null,
				method: init?.method ?? "GET",
				path: url.pathname,
			};
			calls.push(call);
			return await Promise.resolve(respond(call));
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	clearSettingReveal();
	globalThis.fetch = originalFetch;
	useNodeStore.setState(originalNodes);
});

async function settle(ms = 20) {
	await act(async () => {
		await Bun.sleep(ms);
	});
}

async function until(predicate: () => boolean, reason: string) {
	for (let attempt = 0; attempt < 150; attempt += 1) {
		if (predicate()) {
			return;
		}
		await settle(10);
	}
	throw new Error(`${reason}: ${document.body.textContent}`);
}

const opened: string[] = [];

async function mount(gatewayKeys = true) {
	opened.length = 0;
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	const client = new QueryClient({
		defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<MemoryRouter>
					<EntitlementProvider>
						<LlmProvidersSettings
							gatewayKeys={
								gatewayKeys ? <p data-gateway-keys-card="">keys</p> : undefined
							}
							onOpenSection={(section) => opened.push(section)}
						/>
					</EntitlementProvider>
				</MemoryRouter>
			</QueryClientProvider>
		)
	);
	await until(
		() => document.querySelector("[data-provider-pages]") !== null,
		"provider settings never loaded"
	);
}

function one<T extends HTMLElement = HTMLElement>(selector: string): T {
	const element = document.querySelector<T>(selector);
	if (!element) {
		throw new Error(`Missing ${selector}: ${document.body.textContent}`);
	}
	return element;
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
	await settle();
}

function row(rowId: string): HTMLElement {
	return one(`[data-provider-page-row="${rowId}"]`);
}

async function openRow(rowId: string) {
	await click(row(rowId));
	await until(
		() => document.querySelector("[data-provider-page]") !== null,
		`page of ${rowId} never opened`
	);
}

async function back() {
	await click(one('button[aria-label^="Back to"]'));
	await until(
		() => document.querySelector("[data-provider-list]") !== null,
		"list never came back"
	);
}

async function search(value: string) {
	const field = one<HTMLInputElement>('input[type="search"]');
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await settle();
}

/** The row ids on the list, top to bottom. */
function rowIds(): string[] {
	return Array.from(
		document.querySelectorAll<HTMLElement>("[data-provider-page-row]")
	).map((element) => element.getAttribute("data-provider-page-row") ?? "");
}

function sections(): string[] {
	return Array.from(
		document.querySelectorAll<HTMLElement>("[data-provider-page-section]")
	).map((element) => element.getAttribute("data-provider-page-section") ?? "");
}

function poolWrites(): Call[] {
	return calls.filter(
		(call) => call.method === "PUT" && call.path.startsWith(`${POOLS}/`)
	);
}

test("the list is one level: default, connected, other, then the shared pages", async () => {
	await mount();
	expect(rowIds()).toEqual([
		"default",
		"provider:gateway",
		"provider:claude-pro-max",
		"provider:openai",
		"provider:groq",
		"custom-provider",
		"account-pools",
		"agent-models",
		"model-parameters",
		"capabilities",
		"gateway-keys",
		"section:keys",
		"section:integrations",
		"section:routing",
	]);
	// One quiet line per provider: its kind and how it is connected.
	expect(row("provider:claude-pro-max").textContent).toContain(
		"Subscription · Accounts: 2"
	);
	expect(row("provider:openai").textContent).toContain("API key · Team key");
	expect(row("provider:groq").textContent).toContain("API key · Not connected");
	expect(row("default").textContent).toContain("Default provider");
	// One status at the end of a row, as a short word.
	const claudeRow = row("provider:claude-pro-max").closest(
		'[data-slot="item"]'
	);
	expect(claudeRow?.textContent).toContain("Needs sign-in");
	// The pools row carries the number of pools.
	await until(
		() =>
			row("account-pools")
				.closest('[data-slot="item"]')
				?.textContent?.includes("2") === true,
		"pool count never shown"
	);
});

test("search narrows every group and says so when nothing matches", async () => {
	await mount();
	await search("claude");
	expect(rowIds()).toEqual(["provider:claude-pro-max"]);
	expect(document.querySelector("[data-provider-list-empty]")).toBeNull();

	// An account's name finds its provider, a model id finds its provider.
	await search("home@example");
	expect(rowIds()).toEqual(["provider:claude-pro-max"]);
	await search("gpt-5.2");
	expect(rowIds()).toEqual(["provider:openai"]);
	// The shared pages are found by what they are for.
	await search("rotation");
	expect(rowIds()).toEqual(["account-pools"]);

	await search("no such provider");
	expect(rowIds()).toEqual([]);
	expect(one("[data-provider-list-empty]").textContent).toBe(
		"Nothing matches your search."
	);
	expect(one("[data-provider-list-empty]").getAttribute("role")).toBe("status");

	// The search text survives a visit to a page.
	await search("groq");
	await openRow("provider:groq");
	await back();
	expect(one<HTMLInputElement>('input[type="search"]').value).toBe("groq");
	expect(rowIds()).toEqual(["provider:groq"]);
});

test("every provider page shows the same sections in the same order, only those that apply", async () => {
	await mount();
	await openRow("provider:gateway");
	expect(sections()).toEqual(["routing", "models"]);
	await back();

	await openRow("provider:claude-pro-max");
	expect(sections()).toEqual(["accounts", "routing", "models"]);
	await back();

	await openRow("provider:openai");
	expect(sections()).toEqual([
		"accounts",
		"api-key",
		"routing",
		"models",
		"danger",
	]);
	// Remove sits in the danger zone only, not beside the key field as well.
	const removeButtons = Array.from(document.querySelectorAll("button")).filter(
		(candidate) => candidate.textContent?.trim() === "Remove"
	);
	expect(
		removeButtons.filter((candidate) =>
			candidate.closest('[data-provider-page-section="danger"]')
		)
	).toHaveLength(1);
	expect(
		removeButtons.filter((candidate) =>
			candidate.closest('[data-provider-page-section="api-key"]')
		)
	).toHaveLength(0);
	await back();

	await openRow("provider:groq");
	expect(sections()).toEqual(["api-key", "routing", "models"]);
});

test("a page takes focus on its title, and back returns focus to the row that opened it", async () => {
	await mount();
	await openRow("provider:openai");
	const title = one("[data-provider-page] h3");
	expect(title.textContent).toBe("OpenAI");
	expect(document.activeElement).toBe(title);
	// The back control names the list it returns to.
	expect(one('button[aria-label^="Back to"]').getAttribute("aria-label")).toBe(
		"Back to AI providers"
	);

	await back();
	expect(document.activeElement).toBe(row("provider:openai"));

	// The default row opens the default provider and gets the focus back itself.
	await openRow("default");
	expect(one("[data-provider-page] h3").textContent).toBe("Ryu");
	await back();
	expect(document.activeElement).toBe(row("default"));

	await openRow("model-parameters");
	expect(document.activeElement).toBe(one("[data-provider-page] h3"));
	await back();
	expect(document.activeElement).toBe(row("model-parameters"));
});

/** Open the pool menu of one account and click the pool named `pool`. */
async function togglePool(accountId: string, pool: string) {
	const line = one(`[data-pool-account="${accountId}"]`);
	const trigger = line.querySelector<HTMLElement>("button");
	if (!trigger) {
		throw new Error(`Missing pool menu of ${accountId}`);
	}
	await click(trigger);
	const item = Array.from(
		document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')
	).find((candidate) => candidate.textContent?.trim() === pool);
	if (!item) {
		throw new Error(`Missing pool ${pool} in the menu`);
	}
	await click(item);
	// A checkbox item keeps its menu open, so several pools can be changed in
	// one visit. Close it the way a user does before the next menu opens.
	await act(async () => {
		(document.activeElement ?? document.body).dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
		);
	});
	await until(
		() => document.querySelector('[role="menuitemcheckbox"]') === null,
		"pool menu never closed"
	);
}

test("the accounts section shows each account's pools and its menu adds or takes out", async () => {
	await mount();
	await openRow("provider:claude-pro-max");
	await until(
		() => document.querySelector("[data-pool-account]") !== null,
		"pool block never shown"
	);
	// The pool block sits inside the Accounts section of this provider.
	expect(
		one("[data-provider-account-pools]").closest(
			'[data-provider-page-section="accounts"]'
		)
	).not.toBeNull();
	expect(one('[data-pool-account="work"]').textContent).toContain("Mythos");
	expect(one('[data-pool-account="work"]').textContent).toContain(
		"Night shift"
	);
	expect(one('[data-pool-account="home"]').textContent).toContain("Mythos");
	expect(one('[data-pool-account="home"]').textContent).not.toContain(
		"Night shift"
	);
	expect(
		one('[data-pool-account="home"] button').getAttribute("aria-label")
	).toBe("Pools for home@example.com");

	// Put the second account into the second pool: the pool keeps its others.
	await togglePool("home", "Night shift");
	await until(() => poolWrites().length === 1, "pool never saved");
	expect(poolWrites()[0]).toEqual({
		body: { accounts: [WORK, HOME] },
		method: "PUT",
		path: `${POOLS}/pool-2`,
	});
	await until(
		() =>
			one('[data-pool-account="home"]').textContent?.includes("Night shift") ===
			true,
		"new pool never shown on the account"
	);

	// Take the first account out of the first pool.
	await togglePool("work", "Mythos");
	await until(() => poolWrites().length === 2, "pool never saved again");
	expect(poolWrites()[1]).toEqual({
		body: { accounts: [HOME] },
		method: "PUT",
		path: `${POOLS}/pool-1`,
	});

	// "Manage" opens the one page that manages the pools themselves.
	const manage = Array.from(
		one("[data-provider-account-pools]").querySelectorAll("button")
	).find((candidate) => candidate.textContent?.trim() === "Manage");
	if (!manage) {
		throw new Error("Missing Manage");
	}
	await click(manage);
	expect(one("[data-provider-page] h3").textContent).toBe("Account pools");
});

test("the pools page lists the agents on a pool with the accounts they rotate over", async () => {
	await mount();
	await openRow("account-pools");
	await until(
		() => document.querySelector("[data-agent-pool-use]") !== null,
		"agents on pools never listed"
	);
	const use = one('[data-agent-pool-use="security"]').closest(
		'[data-slot="item"]'
	);
	expect(use?.textContent).toContain("Mythos");
	expect(one("[data-agent-pool-accounts]").textContent).toBe(
		"Claude Pro/Max: work@example.com, Claude Pro/Max: home@example.com"
	);
});

test("the rows for keys, integrations and routing open those panes of the window", async () => {
	await mount();
	await click(row("section:keys"));
	await click(row("section:integrations"));
	await click(row("section:routing"));
	expect(opened).toEqual(["keys", "integrations", "routing"]);
	// They leave the list in place: no page of this pane was opened.
	expect(document.querySelector("[data-provider-page]")).toBeNull();
});

test("a page whose provider left the catalog closes and the list takes the focus", async () => {
	await mount();
	await openRow("provider:openai");
	const remove = Array.from(document.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === "Remove"
	);
	if (!remove) {
		throw new Error("Missing Remove");
	}
	await click(remove);
	await until(
		() => document.querySelector("[data-provider-list]") !== null,
		"list never came back"
	);
	expect(rowIds()).not.toContain("provider:openai");
	expect(document.activeElement).toBe(one('input[type="search"]'));
});

test("the gateway keys card of the old command dialog is a page, shown only when the host gives it", async () => {
	await mount();
	await openRow("gateway-keys");
	expect(one("[data-provider-page] h3").textContent).toBe("Gateway keys");
	expect(one("[data-gateway-keys-card]").textContent).toBe("keys");
	for (const root of roots.splice(0)) {
		await act(async () => root.unmount());
	}
	document.body.replaceChildren();
	await mount(false);
	expect(rowIds()).not.toContain("gateway-keys");
});

test("a settings search result opens the page it names", async () => {
	const hit = SETTINGS_ENTRIES.find(
		(entry) => entry.id === "gw.providers.account-pools"
	);
	if (!hit) {
		throw new Error("Missing the Account pools search row");
	}
	requestSettingReveal(hit);
	await mount();
	await until(
		() => document.querySelector("[data-provider-page]") !== null,
		"search hit never opened its page"
	);
	expect(one("[data-provider-page] h3").textContent).toBe("Account pools");
	// Back from a page opened by search lands on that page's row.
	await back();
	expect(document.activeElement).toBe(row("account-pools"));
});

test("every provider search row names a page that exists", () => {
	const rows = SETTINGS_ENTRIES.filter(
		(entry) => entry.dialog === "gateway" && entry.section === "providers"
	);
	expect(rows.map((entry) => [entry.id, entry.subpage ?? null])).toEqual([
		["gw.providers.list", null],
		["gw.providers.account-pools", "account-pools"],
		["gw.providers.agent-models", "agent-models"],
		["gw.providers.model-parameters", "model-parameters"],
		["gw.providers.custom", "custom-provider"],
		["gw.providers.media", "capabilities"],
	]);
});
