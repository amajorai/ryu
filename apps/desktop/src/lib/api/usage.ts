// apps/desktop/src/lib/api/usage.ts
//
// Subscription usage for the desktop: the per-agent usage bar, and the owner-only
// subscriptions primitive (provider → saved accounts → one usage reading each).
//
// When a subscription ACP agent is active in chat (Claude Code, Codex, Copilot,
// Grok, GLM, Devin, OpenCode Go, or Ollama Cloud), Core reads that provider's
// existing local credential and calls the vendor's usage endpoint, returning its
// rolling rate-limit windows plus the non-percent figures — credit balances,
// Codex's banked rate-limit resets and their per-credit expiry dates — à la
// CodexBar / openusage. Ryu's own saved provider accounts are read through
// `GET /api/usage/subscriptions*`, which reports per provider which accounts can
// report usage (`capabilities.accountUsage`) so this side keeps no provider list.
//
// The wire model and its schemas live in `@ryuhq/core-client/usage.ts`; Core owns
// all provider logic + the never-refresh token safety. This module only routes
// the requests through the desktop's authenticated `request`.
//
// The agent route always returns 200: refusals carry `available: false` + a
// `reason` rather than an error, so callers never branch on HTTP status — they
// hide the bar on `unsupported` and show a hint otherwise.

import {
	type ProviderUsageReading,
	providerUsageReadingSchema,
	type SubscriptionProvider,
	type SubscriptionsSnapshot,
	type SubscriptionUsageMode,
	subscriptionsSnapshotSchema,
	toUsageSnapshot,
	type UsageReason,
	type UsageSnapshot,
	usageSnapshotWireSchema,
} from "@ryuhq/core-client/usage.ts";
import { z } from "zod";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { request } from "@/src/lib/api/client.ts";

export type {
	PoolStrategy,
	ProviderUsageReading,
	ProviderUsageWindow,
	SubscriptionAccount,
	SubscriptionAccountState,
	SubscriptionProvider,
	SubscriptionsSnapshot,
	SubscriptionUsageMode,
	UsageMeter,
	UsageReason,
	UsageSnapshot,
	UsageValue,
	UsageValueKind,
	UsageWindow,
} from "@ryuhq/core-client/usage.ts";
export {
	eligiblePoolAccounts,
	hasReadableAccountWindows,
	subscriptionQueryKeys,
} from "@ryuhq/core-client/usage.ts";

/**
 * The engine substrings Core's `engine_for_agent` recognizes, for ACP agents.
 * Kept in lockstep with that list: this side is only a poll filter, but a
 * missing entry silently hides an agent's bar. Ryu's own provider accounts do
 * not use this list; Core reports their capability in the subscriptions
 * snapshot.
 */
const USAGE_ENGINE_HINTS = [
	"claude",
	"codex",
	"chatgpt",
	"copilot",
	"grok",
	"glm",
	"zai",
	"devin",
	"opencode",
	"ollama",
	"cursor",
	"gemini",
	"antigravity",
] as const;

/**
 * Cheap client-side guess of whether an agent has a readable subscription usage
 * window, mirroring Core's `engine_for_agent`. Used to gate the poll so we don't
 * hit the endpoint every few minutes for agents that will always answer
 * `unsupported` (Core is the source of truth — this is just a poll filter).
 */
export function supportsUsage(agentId: string | null | undefined): boolean {
	if (!agentId) {
		return false;
	}
	const id = agentId.toLowerCase();
	return USAGE_ENGINE_HINTS.some((hint) => id.includes(hint));
}

/**
 * A configured Ryu provider row (picker, settings). `accountUsage` is Core's
 * `capabilities.accountUsage` for the provider, from the subscriptions
 * snapshot; absent means "not known", which keeps the row quiet.
 */
export interface SubscriptionUsageProviderRef {
	accountUsage?: boolean;
	authKind: string;
	configured: boolean;
	id: string;
	managed: boolean;
}

/**
 * Whether a Ryu provider is eligible for the same subscription usage badge as
 * an installed ACP agent. Managed Ryu pool rows have their own grant badge,
 * unconfigured rows stay quiet until a login exists, and only providers whose
 * saved accounts Core can read (`capabilities.accountUsage`) qualify.
 */
export function supportsSubscriptionProviderUsage(
	provider: SubscriptionUsageProviderRef | SubscriptionProvider
): boolean {
	if ("capabilities" in provider) {
		return (
			provider.kind === "subscription" &&
			!provider.managed &&
			provider.capabilities.accountUsage &&
			provider.accounts.length > 0
		);
	}
	return (
		provider.authKind === "subscription" &&
		provider.configured &&
		!provider.managed &&
		provider.accountUsage === true
	);
}

/**
 * The usage-bar model for one {@link ProviderUsageReading}, so a saved provider
 * account renders through exactly the same components as an ACP agent. An
 * `account_not_found` reading has no bar-level meaning beyond "no data".
 */
export function usageSnapshotFromReading(
	reading: ProviderUsageReading
): UsageSnapshot {
	const reason: UsageReason | null =
		reading.reason === "account_not_found" ? "error" : (reading.reason ?? null);
	const snapshot: UsageSnapshot = {
		agentId: reading.agentId ?? reading.providerId,
		engine: reading.engine ?? "",
		available: reading.available,
		plan: reading.plan ?? null,
		reason,
		windows: reading.windows.map((window) => ({
			label: window.label,
			model: window.model ?? null,
			resetsAt: window.resetsAt ?? null,
			usedPercent: window.usedPercent,
			windowSeconds: window.windowSeconds ?? null,
		})),
		meters: reading.meters.map((meter) => ({
			label: meter.label,
			expiresAt: meter.expiresAt,
			resetsAt: meter.resetsAt ?? null,
			values: meter.values.map((value) => ({
				kind: value.kind,
				number: value.number,
				unit: value.unit ?? null,
				currency: null,
			})),
		})),
		extraUsageUsd: reading.extraUsageUsd ?? null,
		retryAfterSeconds: reading.retryAfterSeconds ?? null,
		providerId: reading.providerId,
	};
	if (reading.accountId) {
		snapshot.accountId = reading.accountId;
	}
	return snapshot;
}

/**
 * Fetch the usage snapshot for one agent. `agentId` may be an `acp:`-prefixed id
 * (it's percent-encoded for the path).
 */
export async function fetchAgentUsage(
	target: ApiTarget,
	agentId: string,
	signal?: AbortSignal
): Promise<UsageSnapshot> {
	const wire = await request(
		target,
		`/api/agents/${encodeURIComponent(agentId)}/usage`,
		{ signal },
		usageSnapshotWireSchema
	);
	return toUsageSnapshot(wire);
}

/**
 * Fetch the live subscription meters for one saved Ryu provider account, in the
 * snake_case `UsageSnapshot` shape. The account credential stays in Core's
 * sealed vault; only normalized usage data crosses this boundary.
 */
export async function fetchProviderAccountUsage(
	target: ApiTarget,
	providerId: string,
	accountId: string,
	signal?: AbortSignal
): Promise<UsageSnapshot> {
	const wire = await request(
		target,
		`/api/pi-config/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}/usage`,
		{ signal },
		usageSnapshotWireSchema
	);
	return toUsageSnapshot(wire);
}

export interface FetchSubscriptionsOptions {
	providerId?: string;
	signal?: AbortSignal;
	usage?: SubscriptionUsageMode;
}

/**
 * Every subscription provider with its saved accounts and their usage
 * (owner-only). Labels may be email addresses: display them, never persist them.
 */
export async function fetchSubscriptionsSnapshot(
	target: ApiTarget,
	opts: FetchSubscriptionsOptions = {}
): Promise<SubscriptionsSnapshot> {
	const params = new URLSearchParams();
	if (opts.providerId) {
		params.set("provider", opts.providerId);
	}
	if (opts.usage) {
		params.set("usage", opts.usage);
	}
	const query = params.toString();
	return await request(
		target,
		`/api/usage/subscriptions${query ? `?${query}` : ""}`,
		{ signal: opts.signal },
		subscriptionsSnapshotSchema
	);
}

export interface FetchProviderUsageReadingOptions {
	/** Omitted reads the provider's active account; `accountId` echoes which. */
	accountId?: string | null;
	providerId: string;
	/** `"force"` always reads the vendor; omitted serves a fresh cached reading. */
	refresh?: "force";
	signal?: AbortSignal;
}

/** One account's usage reading. An unknown account reads `account_not_found`. */
export async function fetchProviderUsageReading(
	target: ApiTarget,
	opts: FetchProviderUsageReadingOptions
): Promise<ProviderUsageReading> {
	const params = new URLSearchParams();
	if (opts.accountId) {
		params.set("account", opts.accountId);
	}
	if (opts.refresh) {
		params.set("refresh", opts.refresh);
	}
	const query = params.toString();
	return await request(
		target,
		`/api/usage/subscriptions/${encodeURIComponent(opts.providerId)}/reading${query ? `?${query}` : ""}`,
		{ signal: opts.signal },
		providerUsageReadingSchema
	);
}

/**
 * Where {@link ConversationProviderAccount.accountId} came from: the
 * conversation's own SDK affinity, the Claude proxy's session binding, the
 * provider's active account (what the next turn would normally start on), or
 * nothing known.
 */
export type ConversationAccountSource =
	| "affinity"
	| "proxy_binding"
	| "active"
	| "unknown";

const conversationProviderAccountSchema = z.looseObject({
	providerId: z.string().nullish(),
	accountId: z.string().nullish(),
	source: z
		.enum(["affinity", "proxy_binding", "active", "unknown"])
		.catch("unknown"),
});

/** The subscription provider and saved account a conversation runs on (ids only). */
export interface ConversationProviderAccount {
	accountId: string | null;
	providerId: string | null;
	source: ConversationAccountSource;
}

/**
 * Which subscription provider and saved account a conversation runs on, as far
 * as Core can tell without creating or refreshing a binding. Never a label.
 */
export async function fetchConversationProviderAccount(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<ConversationProviderAccount> {
	const parsed = await request(
		target,
		`/api/conversations/${encodeURIComponent(conversationId)}/provider-account`,
		{ signal },
		conversationProviderAccountSchema
	);
	return {
		providerId: parsed.providerId ?? null,
		accountId: parsed.accountId ?? null,
		source: parsed.source,
	};
}
