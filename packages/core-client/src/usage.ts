// packages/core-client/src/usage.ts
//
// Canonical wire model for subscription usage: the per-agent/per-account
// `UsageSnapshot` (snake_case, `GET /api/agents/{id}/usage` and
// `GET /api/pi-config/providers/{id}/accounts/{account}/usage`) and the
// owner-only subscriptions primitive (camelCase, `GET /api/usage/subscriptions*`):
// provider → saved accounts → one `ProviderUsageReading` per account.
//
// Core owns every provider rule (which engines can read per-account usage, the
// never-refresh token safety, caching and probe rules). This module only
// validates and types what Core sends. Account labels are often email
// addresses; they are present only on owner/consented surfaces, so treat them
// as display data and never persist them.
//
// Schemas are loose (`z.looseObject`) so a newer Core can add fields without
// breaking an older surface. Closed sets that a newer Core may extend (reasons,
// account states, pool strategies) degrade to a safe value instead of failing
// the whole parse.

import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

// ── UsageSnapshot (snake_case wire, camelCase model) ────────────────────────

/** Why a snapshot has no live windows (mirrors Core's `UsageUnavailable`). */
export type UsageReason =
	| "unsupported"
	| "not_logged_in"
	| "token_expired"
	| "missing_scope"
	| "no_plan"
	| "rate_limited"
	| "error";

const USAGE_REASONS = [
	"unsupported",
	"not_logged_in",
	"token_expired",
	"missing_scope",
	"no_plan",
	"rate_limited",
	"error",
] as const satisfies readonly UsageReason[];

/** What a {@link UsageValue}'s number means, so it can be formatted correctly. */
export type UsageValueKind = "percent" | "dollars" | "count";

const usageValueKindSchema = z.enum(["percent", "dollars", "count"]);

/** One rolling rate-limit window. `usedPercent` is 0–100. */
export interface UsageWindow {
	label: string;
	/**
	 * The model this window limits, when it is a per-model window rather than an
	 * account-wide one (Claude's Sonnet/Opus weekly limits, Codex's Spark pair).
	 * `null` = account-wide. Core reports this so the client never infers it
	 * from the label.
	 */
	model: string | null;
	resetsAt: string | null;
	usedPercent: number;
	/** The window's own length in seconds, when the vendor reports it. */
	windowSeconds: number | null;
}

/** One figure on a {@link UsageMeter} row. */
export interface UsageValue {
	/** Billing currency when the provider reports one; absent for unitless values. */
	currency?: string | null;
	kind: UsageValueKind;
	number: number;
	/** Unit noun for the label ("credits", "available", "cap"), when it adds anything. */
	unit: string | null;
}

/**
 * A usage row that is NOT a 0–100 bar: a credit balance, banked rate-limit
 * resets, extra-usage dollars. `expiresAt` carries one date per underlying item.
 */
export interface UsageMeter {
	expiresAt: string[];
	label: string;
	resetsAt: string | null;
	values: UsageValue[];
}

/** Normalized usage snapshot for one agent or one saved provider account. */
export interface UsageSnapshot {
	/** The saved account that was read, when the read came from Ryu's vault. */
	accountId?: string | null;
	agentId: string;
	available: boolean;
	engine: string;
	extraUsageUsd: number | null;
	meters: UsageMeter[];
	plan: string | null;
	/** The Ryu provider whose vault account was read, when known. */
	providerId?: string | null;
	reason: UsageReason | null;
	/** Seconds to wait, from a rate-limited vendor's `Retry-After`. */
	retryAfterSeconds: number | null;
	windows: UsageWindow[];
}

const usageReasonWireSchema = z
	.string()
	.nullish()
	.transform((value): UsageReason | null => {
		if (value === null || value === undefined) {
			return null;
		}
		// A reason this surface does not know yet still means "no live data".
		return (USAGE_REASONS as readonly string[]).includes(value)
			? (value as UsageReason)
			: "error";
	});

const usageWindowWireSchema = z.looseObject({
	label: z.string(),
	model: z.string().nullish(),
	resets_at: z.string().nullish(),
	used_percent: z.number(),
	window_seconds: z.number().nullish(),
});

const usageValueWireSchema = z.looseObject({
	currency: z.string().nullish(),
	kind: usageValueKindSchema,
	number: z.number(),
	unit: z.string().nullish(),
});

const usageMeterWireSchema = z.looseObject({
	expires_at: z.array(z.string()).nullish(),
	label: z.string(),
	resets_at: z.string().nullish(),
	values: z.array(usageValueWireSchema),
});

/** Core's snake_case `UsageSnapshot`, exactly as the usage routes send it. */
export const usageSnapshotWireSchema = z.looseObject({
	agent_id: z.string(),
	provider_id: z.string().nullish(),
	account_id: z.string().nullish(),
	engine: z.string(),
	available: z.boolean(),
	plan: z.string().nullish(),
	reason: usageReasonWireSchema,
	windows: z.array(usageWindowWireSchema),
	meters: z.array(usageMeterWireSchema).nullish(),
	extra_usage_usd: z.number().nullish(),
	retry_after_seconds: z.number().nullish(),
});

export type UsageSnapshotWire = z.output<typeof usageSnapshotWireSchema>;

/** Convert Core's snake_case snapshot into the camelCase client model. */
export function toUsageSnapshot(wire: UsageSnapshotWire): UsageSnapshot {
	const snapshot: UsageSnapshot = {
		agentId: wire.agent_id,
		engine: wire.engine,
		available: wire.available,
		plan: wire.plan ?? null,
		reason: wire.reason ?? null,
		windows: wire.windows.map((w) => ({
			label: w.label,
			usedPercent: w.used_percent,
			resetsAt: w.resets_at ?? null,
			windowSeconds: w.window_seconds ?? null,
			model: w.model ?? null,
		})),
		meters: (wire.meters ?? []).map((m) => ({
			label: m.label,
			values: m.values.map((v) => ({
				number: v.number,
				kind: v.kind,
				currency: v.currency ?? null,
				unit: v.unit ?? null,
			})),
			expiresAt: m.expires_at ?? [],
			resetsAt: m.resets_at ?? null,
		})),
		extraUsageUsd: wire.extra_usage_usd ?? null,
		retryAfterSeconds: wire.retry_after_seconds ?? null,
	};
	// Older Core omits the vault identity; keep the fields absent rather than
	// inventing `null`s so existing equality checks stay stable.
	if (wire.provider_id) {
		snapshot.providerId = wire.provider_id;
	}
	if (wire.account_id) {
		snapshot.accountId = wire.account_id;
	}
	return snapshot;
}

// ── ProviderUsageReading and the subscriptions snapshot (camelCase) ─────────

/** Why a reading has no live data; adds `account_not_found` to {@link UsageReason}. */
export type ProviderUsageReason = UsageReason | "account_not_found";

const PROVIDER_USAGE_REASONS = [
	...USAGE_REASONS,
	"account_not_found",
] as const satisfies readonly ProviderUsageReason[];

const providerUsageReasonSchema = z
	.enum(PROVIDER_USAGE_REASONS)
	.nullish()
	.catch("error");

/** Pool rotation strategies (mirrors Core's `oauth_pool_policy::Strategy`). */
export const POOL_STRATEGIES = [
	"manual",
	"round_robin",
	"quota_first",
	"fill_first",
	"reset_first",
] as const;
export type PoolStrategy = (typeof POOL_STRATEGIES)[number];
const poolStrategySchema = z.enum(POOL_STRATEGIES);

/** A projected percent window. `targetId` is stable across reads (monitor baselines). */
export const providerUsageWindowSchema = z.looseObject({
	/** `window:{label}:{model}:{window_seconds}`, byte-identical to Core. */
	targetId: z.string(),
	label: z.string(),
	scope: z.enum(["account", "model"]),
	model: z.string().nullish(),
	usedPercent: z.number(),
	remainingPercent: z.number(),
	resetsAt: z.string().nullish(),
	windowSeconds: z.number().nullish(),
	/** Short display label ("5h", "7d"). */
	window: z.string(),
});
export type ProviderUsageWindow = z.output<typeof providerUsageWindowSchema>;

/** One figure of a projected meter. `targetId` is `meter:{label}:{kind}:{unit}`. */
export const providerUsageMeterValueSchema = z.looseObject({
	targetId: z.string(),
	number: z.number(),
	kind: usageValueKindSchema,
	unit: z.string().nullish(),
	resetsAt: z.string().nullish(),
});
export type ProviderUsageMeterValue = z.output<
	typeof providerUsageMeterValueSchema
>;

/** A projected non-percent meter (credit balance, banked resets). */
export const providerUsageMeterSchema = z.looseObject({
	label: z.string(),
	values: z.array(providerUsageMeterValueSchema),
	resetsAt: z.string().nullish(),
	expiresAt: z.array(z.string()),
});
export type ProviderUsageMeter = z.output<typeof providerUsageMeterSchema>;

/**
 * One canonical, self-describing usage reading. `accountId` is the account
 * that was actually read. `available: false` with no `reason` means pending:
 * nothing was cached yet and Core chose not to wait for the vendor.
 *
 * `accountId`, `accountLabel`, `observedAt` and `cached` are optional because
 * older Core builds (and the monitors usage proxy) send the projection without
 * them; `accountLabel` is always null on agent-visible surfaces.
 */
export const providerUsageReadingSchema = z.looseObject({
	providerId: z.string(),
	accountId: z.string().nullish(),
	accountLabel: z.string().nullish(),
	agentId: z.string().nullish(),
	engine: z.string().nullish(),
	available: z.boolean(),
	plan: z.string().nullish(),
	reason: providerUsageReasonSchema,
	modelMatched: z.boolean().nullish(),
	observedAt: z.string().optional(),
	cached: z.boolean().optional(),
	retryAfterSeconds: z.number().nullish(),
	extraUsageUsd: z.number().nullish(),
	windows: z.array(providerUsageWindowSchema),
	meters: z.array(providerUsageMeterSchema),
});
export type ProviderUsageReading = z.output<typeof providerUsageReadingSchema>;

export const SUBSCRIPTION_ACCOUNT_STATES = [
	"ok",
	"pending",
	"unavailable",
	"needs_reauth",
	"pool_disabled",
	"unsupported",
] as const;
export type SubscriptionAccountState =
	(typeof SUBSCRIPTION_ACCOUNT_STATES)[number];

/** One saved login of a provider. `label` is null unless labels were requested. */
export const subscriptionAccountSchema = z.looseObject({
	accountId: z.string(),
	label: z.string().nullish(),
	kind: z.string(),
	active: z.boolean(),
	gatewayActive: z.boolean(),
	needsReauth: z.boolean(),
	/** Epoch milliseconds of the account's last write. */
	updatedAt: z.number(),
	connectionState: z.string().nullish(),
	poolEnabled: z.boolean(),
	poolPriority: z.number().nullish(),
	// A state this surface does not know yet is shown as unavailable.
	state: z.enum(SUBSCRIPTION_ACCOUNT_STATES).catch("unavailable"),
	usage: providerUsageReadingSchema.nullish(),
});
export type SubscriptionAccount = z.output<typeof subscriptionAccountSchema>;

/** What Core can do with a provider's saved accounts. */
export const subscriptionCapabilitiesSchema = z.looseObject({
	/** Each saved account can report its own usage. */
	accountUsage: z.boolean(),
	/** Each saved account can be pinged by warmup. */
	accountPing: z.boolean(),
	/** `"proxy"` is reserved for future native-proxy pinning. */
	accountPinning: z.enum(["none", "sdk", "proxy"]).catch("none"),
	poolStrategies: z
		.array(z.string())
		.transform((values) =>
			values.filter((value): value is PoolStrategy =>
				(POOL_STRATEGIES as readonly string[]).includes(value)
			)
		),
	quotaObservations: z.boolean(),
});
export type SubscriptionCapabilities = z.output<
	typeof subscriptionCapabilitiesSchema
>;

export const subscriptionProviderSchema = z.looseObject({
	providerId: z.string(),
	label: z.string(),
	kind: z.enum(["subscription", "api_credits", "agent_login"]),
	managed: z.boolean(),
	capabilities: subscriptionCapabilitiesSchema,
	policy: z
		.looseObject({
			strategy: poolStrategySchema.catch("manual"),
			drainThresholdPercent: z.number(),
		})
		.nullish(),
	activeAccountId: z.string().nullish(),
	accounts: z.array(subscriptionAccountSchema),
});
export type SubscriptionProvider = z.output<typeof subscriptionProviderSchema>;

export const subscriptionsSnapshotSchema = z.looseObject({
	version: z.number(),
	generatedAt: z.string(),
	providers: z.array(subscriptionProviderSchema),
});
export type SubscriptionsSnapshot = z.output<
	typeof subscriptionsSnapshotSchema
>;

// ── Owner HTTP fetchers ──────────────────────────────────────────────────────

/**
 * `none` lists accounts without usage; `cached` (default) never waits on a
 * vendor (cold accounts read `pending`); `refresh` reads stale accounts;
 * `force` always reads the vendor.
 */
export type SubscriptionUsageMode = "none" | "cached" | "refresh" | "force";

export interface FetchSubscriptionsOptions {
	providerId?: string;
	signal?: AbortSignal;
	usage?: SubscriptionUsageMode;
}

/** Every subscription provider with its saved accounts and usage (owner-only). */
export function fetchSubscriptionsSnapshot(
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
	return request(
		target,
		`/api/usage/subscriptions${query ? `?${query}` : ""}`,
		{ signal: opts.signal },
		subscriptionsSnapshotSchema
	);
}

export interface FetchProviderUsageReadingOptions {
	/** Omitted reads the provider's active account; `accountId` echoes which. */
	accountId?: string;
	providerId: string;
	/** `true` or `"force"` always reads the vendor (Core treats both as a
	 *  forced read); omit it to re-read only when the cached reading is stale. */
	refresh?: boolean | "force";
	signal?: AbortSignal;
}

/** One account's usage reading. An unknown account reads `account_not_found`. */
export function fetchProviderUsageReading(
	target: ApiTarget,
	opts: FetchProviderUsageReadingOptions
): Promise<ProviderUsageReading> {
	const params = new URLSearchParams();
	if (opts.accountId) {
		params.set("account", opts.accountId);
	}
	if (opts.refresh === "force") {
		params.set("refresh", "force");
	} else if (opts.refresh) {
		params.set("refresh", "1");
	}
	const query = params.toString();
	return request(
		target,
		`/api/usage/subscriptions/${encodeURIComponent(opts.providerId)}/reading${query ? `?${query}` : ""}`,
		{ signal: opts.signal },
		providerUsageReadingSchema
	);
}

// ── Query keys and shared predicates ─────────────────────────────────────────

type QueryKeyTarget = Pick<ApiTarget, "token" | "url" | "userJwt">;

/**
 * Query keys shared by every surface, scoped by node + credentials so a node
 * switch never serves another node's accounts.
 */
export const subscriptionQueryKeys = {
	all: (n: QueryKeyTarget) =>
		["subscriptions", n.url, n.token, n.userJwt ?? null] as const,
	snapshot: (n: QueryKeyTarget, providerId?: string) =>
		[
			"subscriptions",
			n.url,
			n.token,
			n.userJwt ?? null,
			providerId ?? "*",
		] as const,
	reading: (n: QueryKeyTarget, providerId: string, accountId: string | null) =>
		[
			"provider-account-usage",
			n.url,
			n.token,
			n.userJwt ?? null,
			providerId,
			accountId ?? "@active",
		] as const,
};

/**
 * Whether a reading carries at least one account-wide window and every such
 * window is a valid 0–100 percentage — i.e. the account's usage is readable.
 */
export function hasReadableAccountWindows(
	reading: ProviderUsageReading
): boolean {
	if (!reading.available) {
		return false;
	}
	const windows = reading.windows.filter(
		(window) => (window.model ?? null) === null
	);
	return (
		windows.length > 0 &&
		windows.every(
			(window) =>
				Number.isFinite(window.usedPercent) &&
				window.usedPercent >= 0 &&
				window.usedPercent <= 100
		)
	);
}

/** Accounts the pool can route to: enabled, logged in, and readable by Core. */
export function eligiblePoolAccounts(
	provider: SubscriptionProvider
): SubscriptionAccount[] {
	return provider.accounts.filter(
		(account) =>
			account.poolEnabled &&
			!account.needsReauth &&
			account.state !== "unsupported"
	);
}
