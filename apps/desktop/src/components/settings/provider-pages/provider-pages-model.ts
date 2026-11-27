// The pure half of the provider settings pages: which row goes where on the
// list, what its one summary line says, which sections a provider's page
// shows and in what order, and which pools hold an account. No React and no
// copy in here: a summary is a small descriptor that the row turns into text,
// so the catalogs keep every string and these rules stay testable alone.

import type {
	AccountPool,
	AccountPoolCatalog,
	AccountPoolMember,
} from "@/src/lib/api/account-pools.ts";
import { memberKey, toggleMember } from "@/src/lib/api/account-pools.ts";
import type { PiProvider } from "@/src/lib/api/pi-config.ts";
import {
	RETAIL_CREDIT_POOL,
	supportsOAuth,
} from "../LlmProvidersSettings-shared.ts";

/** How a provider is paid for and signed in to. One label per row. */
export type ProviderKind =
	| "managed"
	| "subscription"
	| "api-key"
	| "local"
	| "custom";

export function providerKind(provider: PiProvider): ProviderKind {
	if (provider.custom) {
		return "custom";
	}
	if (provider.managed) {
		return "managed";
	}
	// No credential and not paid through Ryu: an engine on this computer.
	if (provider.authKind === "none") {
		return "local";
	}
	if (!supportsOAuth(provider)) {
		return "api-key";
	}
	// A few providers take a sign-in or a key. The row names the one in use,
	// as the old card said "Connected" for a sign-in and "Configured" for a key.
	if (provider.authKind === "api-key") {
		const signedIn =
			provider.accounts?.some(
				(account) => account.kind === "oauth" && account.active
			) ?? false;
		return signedIn ? "subscription" : "api-key";
	}
	return "subscription";
}

/** A managed provider needs no setup, every other one needs a credential. */
export function providerConnected(provider: PiProvider): boolean {
	return (
		Boolean(provider.managed) ||
		provider.authKind === "none" ||
		provider.configured
	);
}

/** Accounts that Core blocked until the user signs in again. */
export function waitingAccounts(provider: PiProvider): number {
	const blocked = (provider.accounts ?? []).filter(
		(account) => account.needsReauth === true
	).length;
	if (blocked > 0) {
		return blocked;
	}
	return provider.connectionState === "reconnect-required" ? 1 : 0;
}

/** What the org can pay retail Ryu inference with. */
export interface ManagedFunding {
	/** An unrestricted prepaid balance above zero. */
	hasPrepaidBalance: boolean;
	/** The plan includes managed inference. */
	managedInference: boolean;
}

/** A managed provider on a donated pool needs no plan and no balance. */
export function isPoolBacked(provider: PiProvider): boolean {
	return Boolean(
		provider.creditPool && provider.creditPool !== RETAIL_CREDIT_POOL
	);
}

/** The same rule the provider page uses for its "Add prepaid credits" block. */
export function needsPrepaidBalance(
	provider: PiProvider,
	funding: ManagedFunding
): boolean {
	return (
		Boolean(provider.managed) &&
		!isPoolBacked(provider) &&
		!funding.managedInference &&
		!funding.hasPrepaidBalance
	);
}

/** The one summary line of a list row, as data. */
export type ProviderSummary =
	| { id: "managed"; needsCredits: boolean; poolBacked: boolean }
	| { id: "not-connected" }
	| { id: "accounts"; count: number; waiting: number }
	| { id: "account"; label: string; waiting: number }
	| { id: "connected" }
	| { id: "configured" }
	| { id: "ready" };

export function providerSummary(
	provider: PiProvider,
	funding: ManagedFunding
): ProviderSummary {
	if (provider.managed) {
		return {
			id: "managed",
			needsCredits: needsPrepaidBalance(provider, funding),
			poolBacked: isPoolBacked(provider),
		};
	}
	// Nothing to sign in to: the old card said "Configured" or nothing at all.
	if (provider.authKind === "none") {
		return provider.configured ? { id: "configured" } : { id: "ready" };
	}
	if (!provider.configured) {
		return { id: "not-connected" };
	}
	const accounts = provider.accounts ?? [];
	const waiting = waitingAccounts(provider);
	if (accounts.length > 1) {
		return { id: "accounts", count: accounts.length, waiting };
	}
	const only = accounts[0];
	if (only) {
		return { id: "account", label: only.label, waiting };
	}
	// A credential from the environment or models.json lists no account. The
	// old card said "Connected" for a sign-in and "Configured" for a key.
	return supportsOAuth(provider) && provider.authKind !== "api-key"
		? { id: "connected" }
		: { id: "configured" };
}

/** The status at the end of a row. Short words, at most one per row. */
export type ProviderRowStatus = "active" | "needs-sign-in" | "none";

export function providerRowStatus(provider: PiProvider): ProviderRowStatus {
	if (waitingAccounts(provider) > 0) {
		return "needs-sign-in";
	}
	return provider.active ? "active" : "none";
}

/** Everything a search may match on a provider row, lower case. */
export function providerHaystack(provider: PiProvider): string {
	return [
		provider.label,
		provider.id,
		provider.api,
		providerKind(provider),
		...(provider.accounts ?? []).map((account) => account.label),
		...provider.suggestedModels,
	]
		.join("\n")
		.toLowerCase();
}

export function matchesQuery(text: string, query: string): boolean {
	const needle = query.trim().toLowerCase();
	return needle === "" || text.toLowerCase().includes(needle);
}

export interface ProviderGroups {
	connected: PiProvider[];
	other: PiProvider[];
}

/**
 * The two groups of the list, in catalog order (the caller orders the catalog
 * with `orderProviders`, so the managed provider leads). A query narrows both.
 */
export function groupProviders(
	providers: PiProvider[],
	query: string
): ProviderGroups {
	const shown = providers.filter((provider) =>
		matchesQuery(providerHaystack(provider), query)
	);
	return {
		connected: shown.filter(providerConnected),
		other: shown.filter((provider) => !providerConnected(provider)),
	};
}

/** The sections of a provider page. The order here is the order on screen. */
export const PROVIDER_PAGE_SECTIONS = [
	"accounts",
	"api-key",
	"routing",
	"models",
	"danger",
] as const;
export type ProviderPageSection = (typeof PROVIDER_PAGE_SECTIONS)[number];

/** The sections that apply to `provider`, always in the one fixed order. */
export function providerPageSections(
	provider: PiProvider
): ProviderPageSection[] {
	const subscription = supportsOAuth(provider) && !provider.managed;
	const hasAccounts = (provider.accounts?.length ?? 0) > 0;
	const needsKey = provider.authKind === "api-key";
	const applies: Record<ProviderPageSection, boolean> = {
		accounts: subscription || hasAccounts,
		"api-key": needsKey,
		routing: true,
		models: true,
		// The stored credential of a key provider is the one thing to remove.
		danger: needsKey && provider.configured,
	};
	return PROVIDER_PAGE_SECTIONS.filter((section) => applies[section]);
}

/** The pages the list can open besides one page per provider. */
export const EXTRA_PAGES = [
	"account-pools",
	"agent-models",
	"model-parameters",
	"custom-provider",
	"capabilities",
	"gateway-keys",
] as const;
export type ExtraPageId = (typeof EXTRA_PAGES)[number];

/** The rows that leave the pane for another section of the same window. */
export const LINKED_SECTIONS = ["keys", "integrations", "routing"] as const;
export type LinkedSection = (typeof LINKED_SECTIONS)[number];

export type ProviderPageId = ExtraPageId | `provider:${string}`;

export function providerPageId(providerId: string): ProviderPageId {
	return `provider:${providerId}`;
}

/** The provider id of a provider page, or null for every other page. */
export function pageProviderId(page: ProviderPageId): string | null {
	return page.startsWith("provider:") ? page.slice("provider:".length) : null;
}

/**
 * The page a stored id names, or null when it names nothing that exists (a
 * provider that left the catalog, an id from an older build). The host then
 * stays on the list instead of showing an empty page.
 */
export function resolvePage(
	id: string | null | undefined,
	providers: PiProvider[]
): ProviderPageId | null {
	if (!id) {
		return null;
	}
	const extra = EXTRA_PAGES.find((page) => page === id);
	if (extra) {
		return extra;
	}
	const providerId = id.startsWith("provider:")
		? id.slice("provider:".length)
		: id;
	return providers.some((provider) => provider.id === providerId)
		? providerPageId(providerId)
		: null;
}

/** Where an entry point of the old layout lands now. */
export interface EntryTarget {
	/** A page of this pane, or null for the list itself. */
	page: ExtraPageId | "provider" | null;
	/** Another section of the same window, when the row jumps there. */
	section?: LinkedSection;
}

/**
 * Every way into the old provider settings and where it lands now. The keys
 * are the old places: the two in-app links and the search row that opened the
 * pane, the four groups of the command dialog (and the one card only that
 * dialog showed on a self-managed node), and the blocks of the old long page. A test resolves each one, so none can be dropped unnoticed.
 */
export const LEGACY_ENTRY_POINTS: Record<string, EntryTarget> = {
	"link:manage-models-button": { page: null },
	"link:universal-picker-configure-credentials": { page: null },
	"search:gw.providers.list": { page: null },
	"dialog:chat-providers-and-models": { page: null },
	"dialog:image-speech-video-embeddings": { page: "capabilities" },
	"dialog:credentials": { page: null, section: "keys" },
	"dialog:gateway-keys-card": { page: "gateway-keys" },
	"dialog:integrations": { page: null, section: "integrations" },
	"dialog:routing-and-defaults": { page: null, section: "routing" },
	"block:provider-card": { page: "provider" },
	"block:account-pools": { page: "account-pools" },
	"block:agent-models": { page: "agent-models" },
	"block:model-parameters": { page: "model-parameters" },
	"block:custom-provider-form": { page: "custom-provider" },
};

/** The pools that hold one saved account, in catalog order. */
export function poolsOfAccount(
	pools: AccountPool[],
	member: AccountPoolMember
): AccountPool[] {
	const key = memberKey(member);
	return pools.filter((pool) =>
		pool.accounts.some((entry) => memberKey(entry) === key)
	);
}

/** The accounts of `pool` after `member` was added to or taken out of it. */
export function poolAccountsAfterToggle(
	pool: AccountPool,
	member: AccountPoolMember
): AccountPoolMember[] {
	return toggleMember(pool.accounts, member);
}

/** Whether `pool` is full for an account that is not in it yet. */
export function poolIsFullFor(
	pool: AccountPool,
	member: AccountPoolMember,
	maxPoolAccounts: number
): boolean {
	const key = memberKey(member);
	const inside = pool.accounts.some((entry) => memberKey(entry) === key);
	return !inside && pool.accounts.length >= maxPoolAccounts;
}

/** How one agent picks its accounts, for the pools page. */
export interface AgentPoolUse {
	agentId: string;
	backups: { model: string; providerId: string }[];
	mode: "auto" | "pool";
	/** Set when `mode` is "pool" and the pool still exists. */
	pool: AccountPool | null;
}

/**
 * Every agent that is on a pool or on Auto, pools first in catalog order. An
 * agent on neither uses all accounts as before and is left out: the list
 * answers "which accounts does this agent rotate over" only where a rule exists.
 */
export function agentPoolUses(catalog: AccountPoolCatalog): AgentPoolUse[] {
	const backupsOf = (agentId: string) => catalog.backups?.[agentId] ?? [];
	const onPool = Object.entries(catalog.agents).map(
		([agentId, poolId]): AgentPoolUse => ({
			agentId,
			backups: backupsOf(agentId),
			mode: "pool",
			pool: catalog.pools.find((pool) => pool.id === poolId) ?? null,
		})
	);
	const taken = new Set(onPool.map((use) => use.agentId));
	const onAuto = (catalog.auto ?? [])
		.filter((agentId) => !taken.has(agentId))
		.map(
			(agentId): AgentPoolUse => ({
				agentId,
				backups: backupsOf(agentId),
				mode: "auto",
				pool: null,
			})
		);
	return [...onPool, ...onAuto];
}
