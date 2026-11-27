// The Account pools page mounted alone against an in-memory copy of Core's
// pool and agent routes: the pool editor without a second heading, then every
// agent that is on a pool or on Auto with the accounts it rotates over and its
// backup models. The page answers "which accounts does this agent use".

import { afterEach, beforeEach, expect, test } from "bun:test";
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
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { AccountPoolsPage, memberLabel } = await import(
	"./AccountPoolsPage.tsx"
);

const node: Node = {
	name: "account-pools-page",
	url: "https://account-pools-page.fixture:7980",
	token: "account-pools-page-token",
	userJwt: null,
};

const POOLS = "/api/pi-config/providers/account-pools";
const WORK = { accountId: "work", providerId: "claude-pro-max" };
const PLUS = { accountId: "plus", providerId: "chatgpt-plan" };

function account(accountId: string, label: string) {
	return {
		accountId,
		active: false,
		gatewayActive: false,
		kind: "oauth",
		label,
		updatedAt: 0,
	};
}

const ROUTING = {
	credentialKinds: ["oauth"],
	quotaObservations: false,
	strategies: ["manual", "round_robin"],
};
const PROVIDERS = [
	{
		accountRouting: ROUTING,
		accounts: [account("work", "work@example.com")],
		id: "claude-pro-max",
		label: "Claude Pro/Max",
	},
	{
		accountRouting: ROUTING,
		accounts: [account("plus", "plus@example.com")],
		id: "chatgpt-plan",
		label: "ChatGPT",
	},
	{ accounts: [], id: "openai", label: "OpenAI" },
] as unknown as PiProvider[];

interface Call {
	method: string;
	path: string;
}
const originalFetch = globalThis.fetch;
const originalNodes = useNodeStore.getState();
const roots: Root[] = [];
let calls: Call[] = [];
let pools: AccountPoolCatalog;
let supported = true;
/** What `GET /api/agents` answers. A promise holds the answer back. */
let agents: () => Response | Promise<Response>;

function agentList(...entries: [id: string, name: string][]): Response {
	return NativeResponse.json({
		agents: entries.map(([id, name]) => ({ id, name })),
	});
}

function respond(call: Call): Response | Promise<Response> {
	if (call.path === POOLS && call.method === "GET") {
		return supported
			? NativeResponse.json(pools)
			: NativeResponse.json({ error: "no such route" }, { status: 404 });
	}
	if (call.path === "/api/agents" && call.method === "GET") {
		return agents();
	}
	return NativeResponse.json({ error: "undeclared" }, { status: 404 });
}

beforeEach(() => {
	calls = [];
	supported = true;
	agents = () => agentList(["security", "Security review"], ["scout", "Scout"]);
	pools = {
		agents: { security: "pool-1" },
		maxPoolAccounts: 200,
		maxPools: 50,
		pools: [
			// A pool may hold accounts of more than one provider.
			{ accounts: [WORK, PLUS], id: "pool-1", name: "Mythos" },
			{ accounts: [], id: "pool-2", name: "Night shift" },
		],
	};
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: node.name,
		nodes: [node],
	});
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const call: Call = { method: init?.method ?? "GET", path: url.pathname };
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

async function mount(): Promise<HTMLElement> {
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
				<AccountPoolsPage providers={PROVIDERS} />
			</QueryClientProvider>
		)
	);
	await until(
		() => calls.some((call) => call.path === POOLS),
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

/** The row of one agent: its name, the accounts line and the badge. */
function agentRow(host: HTMLElement, agentId: string): HTMLElement {
	const row = one(
		host,
		`[data-agent-pool-use="${agentId}"]`
	).closest<HTMLElement>('[data-slot="item"]');
	if (!row) {
		throw new Error(`Agent ${agentId} is not inside a row`);
	}
	return row;
}

function agentIds(host: HTMLElement): string[] {
	return Array.from(
		host.querySelectorAll<HTMLElement>("[data-agent-pool-use]")
	).map((element) => element.getAttribute("data-agent-pool-use") ?? "");
}

async function agentsShown(host: HTMLElement) {
	await until(
		() => host.querySelector("[data-agent-pool-use]") !== null,
		"agents on pools never listed"
	);
}

test("memberLabel names a pool member by its provider and account, and falls back to the ids", () => {
	expect(memberLabel(WORK, PROVIDERS)).toBe("Claude Pro/Max: work@example.com");
	// An account that was removed keeps its id beside the provider's name.
	expect(
		memberLabel({ accountId: "gone", providerId: "chatgpt-plan" }, PROVIDERS)
	).toBe("ChatGPT: gone");
	// A provider that left the catalog keeps both ids.
	expect(
		memberLabel({ accountId: "a-1", providerId: "old-provider" }, PROVIDERS)
	).toBe("old-provider: a-1");
});

test("the page is the pool editor without a second heading, then the agents", async () => {
	const host = await mount();
	await agentsShown(host);
	// The frame around the page already says "Account pools": the editor does
	// not repeat it, so "Agents" is the only heading inside the page.
	expect(
		Array.from(host.querySelectorAll("h3")).map(
			(heading) => heading.textContent
		)
	).toEqual(["Agents"]);
	// The editor is the one the old long page showed: every pool with its
	// counts and the way to make a new one.
	const listed = Array.from(
		host.querySelectorAll<HTMLElement>("[data-pool-id]")
	);
	expect(listed.map((pool) => pool.getAttribute("data-pool-id"))).toEqual([
		"pool-1",
		"pool-2",
	]);
	expect(listed[0]?.textContent).toContain("Mythos");
	expect(listed[0]?.textContent).toContain("Accounts: 2");
	expect(listed[0]?.textContent).toContain("Agents: 1");
	expect(
		Array.from(host.querySelectorAll("button")).some(
			(button) => button.textContent?.trim() === "New pool"
		)
	).toBe(true);
	// The editor comes first, the agents after it.
	const firstPool = listed[0] as HTMLElement;
	const firstAgent = one(host, "[data-agent-pool-use]");
	expect(
		firstPool.compareDocumentPosition(firstAgent) &
			Node.DOCUMENT_POSITION_FOLLOWING
	).toBeTruthy();
	// Both blocks read one pool catalog.
	expect(calls.filter((call) => call.path === POOLS)).toHaveLength(1);
});

test("an agent on a pool shows its name, the pool, and the accounts it rotates over across providers", async () => {
	const host = await mount();
	await agentsShown(host);
	const row = agentRow(host, "security");
	// The agent's name, not its id.
	expect(one(row, "[data-agent-pool-use]").textContent).toBe("Security review");
	expect(one(row, "[data-agent-pool-accounts]").textContent).toBe(
		"Claude Pro/Max: work@example.com, ChatGPT: plus@example.com"
	);
	// The pool's name is the one status at the end of the row.
	expect(one(row, '[data-slot="badge"]').textContent).toBe("Mythos");
	// No backup models: no second line.
	expect(row.querySelector("[data-agent-pool-backups]")).toBeNull();
});

test("an agent on Auto says so, after the agents on a pool, with its backup models in order", async () => {
	pools = {
		...pools,
		auto: ["scout"],
		backups: {
			scout: [
				{ model: "gpt-5.2", providerId: "openai" },
				{ model: "sonnet-5", providerId: "old-provider" },
			],
		},
		maxBackups: 5,
	};
	const host = await mount();
	await agentsShown(host);
	expect(agentIds(host)).toEqual(["security", "scout"]);
	const row = agentRow(host, "scout");
	expect(one(row, "[data-agent-pool-use]").textContent).toBe("Scout");
	expect(one(row, '[data-slot="badge"]').textContent).toBe("Auto");
	expect(one(row, "[data-agent-pool-accounts]").textContent).toBe(
		"Auto (try every account)"
	);
	// The order is the order they are tried in. A provider that left the
	// catalog keeps its id.
	expect(one(row, "[data-agent-pool-backups]").textContent).toBe(
		"Backup models: gpt-5.2 (OpenAI), sonnet-5 (old-provider)"
	);
});

test("an agent on an empty pool, or on a pool that is gone, says None", async () => {
	pools = { ...pools, agents: { security: "pool-2", scout: "pool-9" } };
	const host = await mount();
	await agentsShown(host);
	const empty = agentRow(host, "security");
	expect(one(empty, '[data-slot="badge"]').textContent).toBe("Night shift");
	expect(one(empty, "[data-agent-pool-accounts]").textContent).toBe("None");
	const gone = agentRow(host, "scout");
	expect(one(gone, '[data-slot="badge"]').textContent).toBe("None");
	expect(one(gone, "[data-agent-pool-accounts]").textContent).toBe("None");
});

test("an agent Core does not list any more keeps its id", async () => {
	agents = () => agentList(["scout", "Scout"]);
	const host = await mount();
	await agentsShown(host);
	expect(one(host, "[data-agent-pool-use]").textContent).toBe("security");
});

test("the agents still show when their names cannot be read", async () => {
	agents = () => NativeResponse.json({ error: "forbidden" }, { status: 403 });
	const host = await mount();
	await agentsShown(host);
	expect(agentIds(host)).toEqual(["security"]);
	expect(one(host, "[data-agent-pool-use]").textContent).toBe("security");
	expect(one(host, "[data-agent-pool-accounts]").textContent).toBe(
		"Claude Pro/Max: work@example.com, ChatGPT: plus@example.com"
	);
});

test("with no agent on a pool the page says so in one line", async () => {
	pools = { ...pools, agents: {} };
	const host = await mount();
	await until(
		() => host.querySelector('p[role="status"]') !== null,
		"empty line never shown"
	);
	const empty = one(host, 'p[role="status"]');
	expect(empty.textContent).toBe("No agent uses a pool yet.");
	expect(agentIds(host)).toEqual([]);
	// The heading stays, so the page keeps its shape.
	expect(one(host, "h3").textContent).toBe("Agents");
});

test("while the agents load the section shows a named placeholder, then the rows", async () => {
	let release: (response: Response) => void = () => undefined;
	agents = () =>
		new Promise<Response>((resolve) => {
			release = resolve;
		});
	const host = await mount();
	await until(
		() => host.querySelector('[aria-label="Loading agents…"]') !== null,
		"placeholder never shown"
	);
	const placeholder = one(host, '[aria-label="Loading agents…"]');
	expect(placeholder.getAttribute("aria-busy")).toBe("true");
	// Neither rows nor the empty line while the names are on their way.
	expect(agentIds(host)).toEqual([]);
	expect(host.querySelector('p[role="status"]')).toBeNull();

	await act(async () => release(agentList(["security", "Security review"])));
	await agentsShown(host);
	expect(host.querySelector('[aria-label="Loading agents…"]')).toBeNull();
	expect(one(host, "[data-agent-pool-use]").textContent).toBe(
		"Security review"
	);
});

test("on a node whose Core has no account pools the page shows nothing", async () => {
	supported = false;
	const host = await mount();
	await settle(50);
	expect(host.textContent).toBe("");
	expect(host.querySelector("h3")).toBeNull();
});
