// The pools block of one provider's Accounts section, mounted alone against
// an in-memory copy of Core's pool routes: which pools each account is in,
// the menu that puts an account into a pool or takes it out, and what the
// block does when a pool is full, a save is refused or the node has no pools.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { AccountPoolCatalog } from "@/src/lib/api/account-pools.ts";
import type { PiProvider } from "@/src/lib/api/pi-config.ts";
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
const { sileo } = await import("sileo");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { ProviderAccountPools } = await import("./ProviderAccountPools.tsx");

const node: Node = {
	name: "provider-account-pools",
	url: "https://provider-account-pools.fixture:7980",
	token: "provider-account-pools-token",
	userJwt: null,
};

const POOLS = "/api/pi-config/providers/account-pools";
const WORK = { accountId: "work", providerId: "claude-pro-max" };
const HOME = { accountId: "home", providerId: "claude-pro-max" };

function account(accountId: string, label: string, kind = "oauth") {
	return {
		accountId,
		active: false,
		gatewayActive: false,
		kind,
		label,
		updatedAt: 0,
	};
}

/** Two sign-ins that can be in a pool and one key that cannot. */
const CLAUDE = {
	accountRouting: {
		credentialKinds: ["oauth"],
		quotaObservations: false,
		strategies: ["manual", "round_robin"],
	},
	accounts: [
		account("work", "work@example.com"),
		account("home", "home@example.com"),
		account("key", "Console key", "api_key"),
	],
	id: "claude-pro-max",
	label: "Claude Pro/Max",
} as PiProvider;

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
let supported = true;
/** Set to answer the next write by hand: a refusal, or a save that hangs. */
let onWrite: ((call: Call) => Response | Promise<Response>) | null = null;
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;

function save(call: Call): Response {
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

function respond(call: Call): Response | Promise<Response> {
	if (call.path === POOLS && call.method === "GET") {
		return supported
			? NativeResponse.json(pools)
			: NativeResponse.json({ error: "no such route" }, { status: 404 });
	}
	if (call.path.startsWith(`${POOLS}/`) && call.method === "PUT") {
		return onWrite ? onWrite(call) : save(call);
	}
	return NativeResponse.json({ error: "undeclared" }, { status: 404 });
}

beforeEach(() => {
	calls = [];
	supported = true;
	onWrite = null;
	pools = {
		agents: {},
		maxPoolAccounts: 200,
		maxPools: 50,
		pools: [
			{ accounts: [WORK], id: "pool-1", name: "Mythos" },
			{ accounts: [], id: "pool-2", name: "Night shift" },
		],
	};
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: node.name,
		nodes: [node],
	});
	errorToast = spyOn(sileo, "error");
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const call: Call = {
				body: init?.body ? JSON.parse(String(init.body)) : null,
				method: init?.method ?? "GET",
				path: url.pathname,
			};
			calls.push(call);
			return await respond(call);
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
	errorToast.mockRestore();
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

let managed = 0;

/** Mounts the block for each provider and waits for the pool catalog. */
async function mount(providers: PiProvider[] = [CLAUDE]): Promise<HTMLElement> {
	managed = 0;
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
				{providers.map((provider) => (
					<ProviderAccountPools
						key={provider.id}
						onManage={() => {
							managed += 1;
						}}
						provider={provider}
					/>
				))}
			</QueryClientProvider>
		)
	);
	await until(
		() => calls.some((call) => call.method === "GET"),
		"pool catalog never asked for"
	);
	await settle();
	return host;
}

function one<T extends HTMLElement = HTMLElement>(
	scope: ParentNode,
	selector: string
): T {
	const element = scope.querySelector<T>(selector);
	if (!element) {
		throw new Error(`Missing ${selector}: ${document.body.textContent}`);
	}
	return element;
}

function line(accountId: string): HTMLElement {
	return one(document, `[data-pool-account="${accountId}"]`);
}

function trigger(accountId: string): HTMLButtonElement {
	return one<HTMLButtonElement>(line(accountId), "button");
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
	await settle();
}

/** Every entry of the open menu, top to bottom. */
function menuItems(): HTMLElement[] {
	return Array.from(
		document.querySelectorAll<HTMLElement>(
			'[role="menuitemcheckbox"], [role="menuitem"]'
		)
	);
}

async function openMenu(accountId: string): Promise<HTMLElement[]> {
	await click(trigger(accountId));
	await until(
		() => menuItems().length > 0,
		`menu of ${accountId} never opened`
	);
	return menuItems();
}

async function closeMenu() {
	await act(async () => {
		(document.activeElement ?? document.body).dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
		);
	});
	await until(() => menuItems().length === 0, "pool menu never closed");
}

function entry(items: HTMLElement[], name: string): HTMLElement {
	const found = items.find((item) => item.textContent?.trim() === name);
	if (!found) {
		throw new Error(`Missing ${name} in the menu`);
	}
	return found;
}

function isDisabled(item: HTMLElement): boolean {
	return (
		item.getAttribute("aria-disabled") === "true" ||
		item.hasAttribute("data-disabled")
	);
}

function writes(): Call[] {
	return calls.filter((call) => call.method === "PUT");
}

test("each account that can be in a pool is one line: its name, its pools or None, and a named menu", async () => {
	const host = await mount();
	const block = one(host, "[data-provider-account-pools]");
	expect(block.getAttribute("data-provider-account-pools")).toBe(
		"claude-pro-max"
	);
	expect(one(block, "h4").textContent).toBe("Account pools");
	// A list of accounts, read out as one. The API key cannot be in a pool
	// (Core routes only this provider's sign-ins), so it has no line.
	const lines = Array.from(block.querySelectorAll("ul > li"));
	expect(lines.map((entry) => entry.getAttribute("data-pool-account"))).toEqual(
		["work", "home"]
	);
	expect(line("work").textContent).toBe("work@example.comMythos");
	expect(line("home").textContent).toBe("home@example.comNone");
	// An icon-only control needs a name, and the name says whose menu it is.
	expect(trigger("work").getAttribute("aria-label")).toBe(
		"Pools for work@example.com"
	);
	expect(trigger("home").getAttribute("aria-label")).toBe(
		"Pools for home@example.com"
	);
	expect(trigger("home").getAttribute("title")).toBe(
		"Pools for home@example.com"
	);
	expect(trigger("home").getAttribute("aria-haspopup")).toBe("menu");
});

test("the menu lists every pool and checks the ones the account is in", async () => {
	await mount();
	const forWork = await openMenu("work");
	expect(forWork.map((item) => item.textContent?.trim())).toEqual([
		"Mythos",
		"Night shift",
	]);
	expect(forWork.map((item) => item.getAttribute("role"))).toEqual([
		"menuitemcheckbox",
		"menuitemcheckbox",
	]);
	expect(entry(forWork, "Mythos").getAttribute("aria-checked")).toBe("true");
	expect(entry(forWork, "Night shift").getAttribute("aria-checked")).toBe(
		"false"
	);
	// The open menu is named by the control that opened it, so it is read as
	// "Pools for work@example.com", and the control points at its menu.
	const menu = one(document, '[role="menu"]');
	expect(menu.getAttribute("aria-labelledby")).toBe(trigger("work").id);
	expect(trigger("work").getAttribute("aria-controls")).toBe(menu.id);
	await closeMenu();

	const forHome = await openMenu("home");
	expect(entry(forHome, "Mythos").getAttribute("aria-checked")).toBe("false");
});

test("checking a pool adds the account and keeps the pool's others, unchecking takes it out", async () => {
	await mount();
	await click(entry(await openMenu("home"), "Mythos"));
	await until(() => writes().length === 1, "pool never saved");
	expect(writes()[0]).toEqual({
		body: { accounts: [WORK, HOME] },
		method: "PUT",
		path: `${POOLS}/pool-1`,
	});
	// The line follows what Core now holds, and the open menu shows the check.
	await until(
		() => line("home").textContent === "home@example.comMythos",
		"new pool never shown on the account"
	);
	expect(entry(menuItems(), "Mythos").getAttribute("aria-checked")).toBe(
		"true"
	);
	await closeMenu();

	await click(entry(await openMenu("work"), "Mythos"));
	await until(() => writes().length === 2, "pool never saved again");
	expect(writes()[1]).toEqual({
		body: { accounts: [HOME] },
		method: "PUT",
		path: `${POOLS}/pool-1`,
	});
	await until(
		() => line("work").textContent === "work@example.comNone",
		"the account never left the pool"
	);
	// Only the accounts of the pool are sent: its name is not touched.
	expect(pools.pools[0]?.name).toBe("Mythos");
});

test("a full pool takes no new account, and an account inside it can still leave", async () => {
	pools = { ...pools, maxPoolAccounts: 1 };
	await mount();
	const forHome = await openMenu("home");
	expect(isDisabled(entry(forHome, "Mythos"))).toBe(true);
	// The empty pool still has room.
	expect(isDisabled(entry(forHome, "Night shift"))).toBe(false);
	await click(entry(forHome, "Mythos"));
	expect(writes()).toHaveLength(0);
	await closeMenu();

	const forWork = await openMenu("work");
	expect(isDisabled(entry(forWork, "Mythos"))).toBe(false);
});

test("with no pool yet every account says None, the menu says so, and Manage opens the pools page", async () => {
	pools = { ...pools, pools: [] };
	const host = await mount();
	expect(line("work").textContent).toBe("work@example.comNone");
	const items = await openMenu("work");
	expect(items).toHaveLength(1);
	expect(items[0]?.textContent).toBe("No account pools yet.");
	expect(items[0]?.getAttribute("role")).toBe("menuitem");
	expect(isDisabled(items[0] as HTMLElement)).toBe(true);
	await closeMenu();

	const manage = Array.from(host.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === "Manage"
	);
	if (!manage) {
		throw new Error("Missing Manage");
	}
	await click(manage);
	expect(managed).toBe(1);
	expect(writes()).toHaveLength(0);
});

test("a save Core refuses says why and leaves the account where it was", async () => {
	onWrite = () =>
		NativeResponse.json(
			{ error: "an account pool holds at most 200 accounts" },
			{ status: 422 }
		);
	await mount();
	const reads = () => calls.filter((call) => call.method === "GET").length;
	const before = reads();
	await click(entry(await openMenu("home"), "Night shift"));
	await until(() => errorToast.mock.calls.length === 1, "refusal never shown");
	expect(errorToast.mock.calls[0]?.[0]).toEqual({
		description: "an account pool holds at most 200 accounts",
		title: "Could not save the account pool.",
	});
	// The catalog is read again, so the block shows what Core really holds.
	await until(() => reads() > before, "catalog never read again");
	await closeMenu();
	expect(line("home").textContent).toBe("home@example.comNone");
});

test("the menus are off while a save is on its way", async () => {
	let release: (response: Response) => void = () => undefined;
	let held: Call | null = null;
	onWrite = (call) =>
		new Promise<Response>((resolve) => {
			held = call;
			release = resolve;
		});
	await mount();
	await click(entry(await openMenu("home"), "Night shift"));
	await until(() => held !== null, "save never sent");
	// No second change can start before the first one is answered.
	expect(trigger("home").disabled).toBe(true);
	expect(trigger("work").disabled).toBe(true);

	await act(async () => release(save(held as unknown as Call)));
	await until(() => !trigger("home").disabled, "menus never came back");
	await until(
		() => line("home").textContent === "home@example.comNight shift",
		"saved pool never shown"
	);
	expect(errorToast.mock.calls).toHaveLength(0);
});

test("nothing is shown on a node whose Core has no account pools", async () => {
	supported = false;
	const host = await mount();
	expect(host.querySelector("[data-provider-account-pools]")).toBeNull();
	expect(host.textContent).toBe("");
	// An older Core answers 404 for good: one read, no retry.
	expect(calls.filter((call) => call.method === "GET")).toHaveLength(1);
});

test("a provider whose accounts cannot be in a pool gets no block, and two providers share one read", async () => {
	const keysOnly = {
		...CLAUDE,
		accounts: [account("key", "Console key", "api_key")],
		id: "anthropic",
		label: "Anthropic",
	} as PiProvider;
	const noRouting = {
		accounts: [account("solo", "Solo")],
		id: "no-routing",
		label: "No routing",
	} as PiProvider;
	const second = {
		...CLAUDE,
		accounts: [account("plus", "plus@example.com")],
		id: "chatgpt-plan",
		label: "ChatGPT",
	} as PiProvider;
	const host = await mount([CLAUDE, keysOnly, noRouting, second]);
	expect(
		Array.from(host.querySelectorAll("[data-provider-account-pools]")).map(
			(block) => block.getAttribute("data-provider-account-pools")
		)
	).toEqual(["claude-pro-max", "chatgpt-plan"]);
	// The same account id under another provider is another account: the
	// pools of Claude's "work" are not shown on ChatGPT's line.
	expect(line("plus").textContent).toBe("plus@example.comNone");
	// One cache entry per node, however many blocks are on the page.
	expect(calls.filter((call) => call.method === "GET")).toHaveLength(1);
});
