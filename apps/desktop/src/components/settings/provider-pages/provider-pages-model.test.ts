// The rules of the provider settings pages, checked without a DOM: where a
// provider sits on the list, what its one summary line says, which sections
// its page shows and in what order, where every entry point of the old layout
// lands, and which pools hold an account.

import { expect, test } from "bun:test";
import type { AccountPoolCatalog } from "@/src/lib/api/account-pools.ts";
import type { PiProvider } from "@/src/lib/api/pi-config.ts";
import {
	agentPoolUses,
	EXTRA_PAGES,
	groupProviders,
	LEGACY_ENTRY_POINTS,
	LINKED_SECTIONS,
	matchesQuery,
	needsPrepaidBalance,
	PROVIDER_PAGE_SECTIONS,
	pageProviderId,
	poolAccountsAfterToggle,
	poolIsFullFor,
	poolsOfAccount,
	providerConnected,
	providerKind,
	providerPageId,
	providerPageSections,
	providerRowStatus,
	providerSummary,
	resolvePage,
	waitingAccounts,
} from "./provider-pages-model.ts";

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

function provider(id: string, extra: Partial<PiProvider> = {}): PiProvider {
	return {
		api: "openai-completions",
		authEnv: "",
		authKind: "api-key",
		configured: false,
		custom: false,
		id,
		label: id,
		routing: "gateway",
		suggestedModels: [],
		...extra,
	} as PiProvider;
}

const managed = provider("gateway", {
	authKind: "none",
	creditPool: "openrouter",
	label: "Ryu",
	managed: true,
});
const donated = provider("workers", {
	authKind: "none",
	creditPool: "cloudflare",
	managed: true,
});
const claude = provider("claude-pro-max", {
	accounts: [
		account("work", "work@example.com"),
		account("home", "home@example.com", { needsReauth: true }),
		account("lab", "lab@example.com"),
	],
	authKind: "subscription",
	configured: true,
	label: "Claude Pro/Max",
	supportsOAuth: true,
} as Partial<PiProvider>);
const chatgpt = provider("chatgpt-plan", {
	authKind: "subscription",
	label: "ChatGPT (plan)",
	supportsOAuth: true,
});
const openai = provider("openai", {
	accounts: [account("key-1", "Team key", { kind: "api_key" })],
	active: true,
	configured: true,
	label: "OpenAI",
	suggestedModels: ["gpt-5.2"],
} as Partial<PiProvider>);
const groq = provider("groq", { label: "Groq" });
const envKey = provider("mistral", { configured: true, label: "Mistral" });
const local = provider("ollama", {
	configured: true,
	custom: true,
	label: "ollama",
});

const engine = provider("local", { authKind: "none", configured: true });
const keyless = provider("llama", { authKind: "none", custom: true });

const NO_FUNDS = { hasPrepaidBalance: false, managedInference: false };
const ON_PLAN = { hasPrepaidBalance: false, managedInference: true };

test("every provider has exactly one kind", () => {
	expect(providerKind(managed)).toBe("managed");
	expect(providerKind(claude)).toBe("subscription");
	expect(providerKind(openai)).toBe("api-key");
	expect(providerKind(local)).toBe("custom");
	// No credential and not paid through Ryu is not "Ryu managed".
	expect(providerKind(engine)).toBe("local");
	expect(providerKind(keyless)).toBe("custom");
	// A provider that takes a sign-in or a key is named by the one in use.
	const either = provider("openrouter", { supportsOAuth: true });
	expect(providerKind(either)).toBe("api-key");
	expect(
		providerKind({
			...either,
			accounts: [account("a", "a@example.com", { active: true })],
		})
	).toBe("subscription");
});

test("managed providers and configured ones are connected, the rest are not", () => {
	expect(providerConnected(managed)).toBe(true);
	expect(providerConnected(claude)).toBe(true);
	expect(providerConnected(chatgpt)).toBe(false);
	expect(providerConnected(groq)).toBe(false);
	// Nothing to sign in to, so nothing is missing.
	expect(providerConnected(keyless)).toBe(true);
});

test("the summary line says how the provider is connected", () => {
	expect(providerSummary(managed, ON_PLAN)).toEqual({
		id: "managed",
		needsCredits: false,
		poolBacked: false,
	});
	expect(providerSummary(managed, NO_FUNDS)).toEqual({
		id: "managed",
		needsCredits: true,
		poolBacked: false,
	});
	expect(providerSummary(donated, NO_FUNDS)).toEqual({
		id: "managed",
		needsCredits: false,
		poolBacked: true,
	});
	expect(providerSummary(claude, NO_FUNDS)).toEqual({
		id: "accounts",
		count: 3,
		waiting: 1,
	});
	expect(providerSummary(openai, NO_FUNDS)).toEqual({
		id: "account",
		label: "Team key",
		waiting: 0,
	});
	expect(providerSummary(groq, NO_FUNDS)).toEqual({ id: "not-connected" });
	expect(providerSummary(envKey, NO_FUNDS)).toEqual({ id: "configured" });
	expect(providerSummary(engine, NO_FUNDS)).toEqual({ id: "configured" });
	expect(providerSummary(keyless, NO_FUNDS)).toEqual({ id: "ready" });
	expect(providerSummary({ ...chatgpt, configured: true }, NO_FUNDS)).toEqual({
		id: "connected",
	});
});

test("prepaid credits are asked for only on the retail pool without a plan or a balance", () => {
	expect(needsPrepaidBalance(managed, NO_FUNDS)).toBe(true);
	expect(needsPrepaidBalance(managed, ON_PLAN)).toBe(false);
	expect(
		needsPrepaidBalance(managed, {
			hasPrepaidBalance: true,
			managedInference: false,
		})
	).toBe(false);
	expect(needsPrepaidBalance(donated, NO_FUNDS)).toBe(false);
	expect(needsPrepaidBalance(openai, NO_FUNDS)).toBe(false);
});

test("a row carries at most one status, and sign-in outranks active", () => {
	expect(waitingAccounts(claude)).toBe(1);
	expect(
		waitingAccounts({ ...chatgpt, connectionState: "reconnect-required" })
	).toBe(1);
	expect(providerRowStatus(claude)).toBe("needs-sign-in");
	expect(providerRowStatus({ ...claude, active: true })).toBe("needs-sign-in");
	expect(providerRowStatus(openai)).toBe("active");
	expect(providerRowStatus(groq)).toBe("none");
});

test("the list has two groups in catalog order", () => {
	const groups = groupProviders(
		[managed, claude, openai, chatgpt, groq, local],
		""
	);
	expect(groups.connected.map((entry) => entry.id)).toEqual([
		"gateway",
		"claude-pro-max",
		"openai",
		"ollama",
	]);
	expect(groups.other.map((entry) => entry.id)).toEqual([
		"chatgpt-plan",
		"groq",
	]);
});

test("search matches a name, a kind, an account and a model, in both groups", () => {
	const all = [managed, claude, openai, chatgpt, groq, local];
	const ids = (query: string) => {
		const groups = groupProviders(all, query);
		return [...groups.connected, ...groups.other].map((entry) => entry.id);
	};
	expect(ids("  CLAUDE ")).toEqual(["claude-pro-max"]);
	expect(ids("home@example")).toEqual(["claude-pro-max"]);
	expect(ids("gpt-5.2")).toEqual(["openai"]);
	expect(ids("subscription")).toEqual(["claude-pro-max", "chatgpt-plan"]);
	expect(ids("gro")).toEqual(["groq"]);
	expect(ids("no such provider")).toEqual([]);
	expect(matchesQuery("Account pools", "POOL")).toBe(true);
	expect(matchesQuery("Account pools", "   ")).toBe(true);
});

test("every provider page shows its sections in the one fixed order", () => {
	expect([...PROVIDER_PAGE_SECTIONS]).toEqual([
		"accounts",
		"api-key",
		"routing",
		"models",
		"danger",
	]);
	// Ryu managed: nothing to sign in to and no key.
	expect(providerPageSections(managed)).toEqual(["routing", "models"]);
	// A subscription: accounts, or Sign in while there is none.
	expect(providerPageSections(claude)).toEqual([
		"accounts",
		"routing",
		"models",
	]);
	expect(providerPageSections(chatgpt)).toEqual([
		"accounts",
		"routing",
		"models",
	]);
	// A stored key: its saved keys, the key field, and the danger zone.
	expect(providerPageSections(openai)).toEqual([
		"accounts",
		"api-key",
		"routing",
		"models",
		"danger",
	]);
	// A key provider that is not connected has nothing to remove yet.
	expect(providerPageSections(groq)).toEqual(["api-key", "routing", "models"]);
	expect(providerPageSections(local)).toEqual([
		"api-key",
		"routing",
		"models",
		"danger",
	]);
	for (const entry of [managed, claude, chatgpt, openai, groq, local]) {
		const shown = providerPageSections(entry);
		const inOrder = PROVIDER_PAGE_SECTIONS.filter((section) =>
			shown.includes(section)
		);
		expect(shown).toEqual(inOrder);
	}
});

test("a page id resolves only to a page that exists", () => {
	const all = [managed, openai];
	expect(resolvePage(null, all)).toBeNull();
	expect(resolvePage("account-pools", all)).toBe("account-pools");
	expect(resolvePage("provider:openai", all)).toBe("provider:openai");
	// A search result may name the bare provider id.
	expect(resolvePage("openai", all)).toBe("provider:openai");
	expect(resolvePage("provider:left-the-catalog", all)).toBeNull();
	expect(pageProviderId(providerPageId("openai"))).toBe("openai");
	expect(pageProviderId("agent-models")).toBeNull();
});

test("every entry point of the old layout still lands somewhere", () => {
	const old = Object.keys(LEGACY_ENTRY_POINTS);
	// The two in-app links, the search row, the four groups of the command
	// dialog (credentials and integrations were one group with two blocks; the
	// gateway keys card was in no other pane of a self-managed node), and
	// the five blocks of the old long page.
	expect(old).toEqual([
		"link:manage-models-button",
		"link:universal-picker-configure-credentials",
		"search:gw.providers.list",
		"dialog:chat-providers-and-models",
		"dialog:image-speech-video-embeddings",
		"dialog:credentials",
		"dialog:gateway-keys-card",
		"dialog:integrations",
		"dialog:routing-and-defaults",
		"block:provider-card",
		"block:account-pools",
		"block:agent-models",
		"block:model-parameters",
		"block:custom-provider-form",
	]);
	const pages: readonly string[] = EXTRA_PAGES;
	const sections: readonly string[] = LINKED_SECTIONS;
	for (const [entry, target] of Object.entries(LEGACY_ENTRY_POINTS)) {
		if (target.section !== undefined) {
			expect(sections, entry).toContain(target.section);
			continue;
		}
		if (target.page === null || target.page === "provider") {
			// The list itself, or one page per provider row of the list.
			continue;
		}
		expect(pages, entry).toContain(target.page);
	}
	// Every extra page is reachable from an old entry point or is new.
	const reached = new Set(
		Object.values(LEGACY_ENTRY_POINTS).map((target) => target.page)
	);
	for (const page of EXTRA_PAGES) {
		expect(reached.has(page), page).toBe(true);
	}
});

const WORK = { accountId: "work", providerId: "claude-pro-max" };
const HOME = { accountId: "home", providerId: "claude-pro-max" };
const KEY = { accountId: "work", providerId: "openai" };
const pools = [
	{ accounts: [WORK, HOME], id: "pool-1", name: "Mythos" },
	{ accounts: [WORK, KEY], id: "pool-2", name: "Night shift" },
	{ accounts: [], id: "pool-3", name: "Empty" },
];

test("an account lists the pools that hold it, told apart by provider", () => {
	expect(poolsOfAccount(pools, WORK).map((pool) => pool.name)).toEqual([
		"Mythos",
		"Night shift",
	]);
	expect(poolsOfAccount(pools, HOME).map((pool) => pool.name)).toEqual([
		"Mythos",
	]);
	// The same account id on another provider is another account.
	expect(poolsOfAccount(pools, KEY).map((pool) => pool.name)).toEqual([
		"Night shift",
	]);
	expect(
		poolsOfAccount(pools, { accountId: "lab", providerId: "claude-pro-max" })
	).toEqual([]);
});

test("the row menu puts an account into a pool or takes it out, keeping the others", () => {
	const mythos = pools[0];
	const empty = pools[2];
	if (!(mythos && empty)) {
		throw new Error("fixture pools missing");
	}
	expect(poolAccountsAfterToggle(mythos, HOME)).toEqual([WORK]);
	expect(poolAccountsAfterToggle(empty, HOME)).toEqual([HOME]);
	expect(poolAccountsAfterToggle(mythos, KEY)).toEqual([WORK, HOME, KEY]);
});

test("a full pool refuses a new account but lets a member leave", () => {
	const mythos = pools[0];
	if (!mythos) {
		throw new Error("fixture pool missing");
	}
	expect(poolIsFullFor(mythos, KEY, 2)).toBe(true);
	expect(poolIsFullFor(mythos, HOME, 2)).toBe(false);
	expect(poolIsFullFor(mythos, KEY, 3)).toBe(false);
});

test("the pools page lists every agent on a pool or on Auto with its backups", () => {
	const catalog: AccountPoolCatalog = {
		agents: { security: "pool-1", ghost: "pool-gone" },
		auto: ["writer", "security"],
		backups: { writer: [{ model: "gpt-5.2", providerId: "openai" }] },
		maxPoolAccounts: 200,
		maxPools: 50,
		pools,
	};
	expect(agentPoolUses(catalog)).toEqual([
		{ agentId: "security", backups: [], mode: "pool", pool: pools[0] ?? null },
		{ agentId: "ghost", backups: [], mode: "pool", pool: null },
		{
			agentId: "writer",
			backups: [{ model: "gpt-5.2", providerId: "openai" }],
			mode: "auto",
			pool: null,
		},
	]);
	// A Core without Auto and backups sends neither field.
	expect(
		agentPoolUses({
			agents: {},
			maxPoolAccounts: 200,
			maxPools: 50,
			pools: [],
		})
	).toEqual([]);
});
