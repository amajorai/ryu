import type {
	GatewayCacheMetrics,
	GatewayHealth,
	GatewayProviderMetrics,
	GatewayRequestMetrics,
	GatewayTokenMetrics,
	ProviderCircuitState,
} from "@ryuhq/core-client/gateway.ts";
import { type ApiTarget, request } from "./client.ts";
import { rawStatusResponseSchema } from "./gateway-status-response-contracts.ts";

/**
 * Live upstream quota / rate-limit snapshot for one provider, as folded into
 * `/metrics` under `provider_quota` by the gateway. Every field may be `null`
 * (never observed / not reported by the upstream). `resetInSecs` is a live
 * countdown computed server-side at snapshot time — tick it down client-side
 * between polls for a smooth display.
 */
export interface ProviderQuota {
	/** Window ceiling, or null if the upstream did not report one. */
	limit: number | null;
	/** Whether the provider is currently rate limited. */
	rateLimited: boolean;
	/** Remaining requests/tokens in the current window, or null if unknown. */
	remaining: number | null;
	/** Unix seconds when the window resets, or null. */
	resetAt: number | null;
	/** Seconds until reset at snapshot time, or null. Tick down client-side. */
	resetInSecs: number | null;
	/** `Retry-After` seconds from the last 429, or null. */
	retryAfter: number | null;
	/** Unix seconds when this snapshot was last updated, or null. */
	updatedAt: number | null;
}

export interface GatewayMetrics {
	cache: GatewayCacheMetrics;
	composioCalls: number;
	/**
	 * Per-provider circuit-breaker health. Only includes providers that have
	 * been observed (at least one request attempted). Empty map when the
	 * circuit breaker has not yet seen any traffic.
	 */
	providerHealth: Record<string, ProviderCircuitState>;
	/**
	 * Per-provider upstream quota / rate-limit countdowns. Only includes
	 * providers whose quota headers have been observed at least once; absent
	 * providers have never been seen. Empty map when nothing observed yet.
	 */
	providerQuota: Record<string, ProviderQuota>;
	providers: GatewayProviderMetrics;
	requests: GatewayRequestMetrics;
	tokens: GatewayTokenMetrics;
}

export interface GatewayStatus {
	/** Health snapshot, present only when reachable. */
	health: GatewayHealth | null;
	/** Metrics snapshot, present when reachable and /metrics responded. */
	metrics: GatewayMetrics | null;
	/** Whether Core could reach a healthy gateway. */
	reachable: boolean;
	/** The gateway base URL Core proxied to. */
	url: string | null;
}

// ── Raw wire shapes (snake_case, as returned by gateway + Core proxy) ──────────

interface RawHealth {
	auth_required?: boolean;
	providers?: string[];
	status?: string;
	version?: string | null;
}

interface RawProviderCircuitState {
	circuit?: string;
	consecutive_failures?: number;
	open_for_secs?: number | null;
}

interface RawProviderQuota {
	limit?: number | null;
	rate_limited?: boolean | null;
	remaining?: number | null;
	reset_at?: number | null;
	reset_in_secs?: number | null;
	retry_after?: number | null;
	updated_at?: number | null;
}

interface RawMetrics {
	cache?: {
		exact_hits?: number;
		semantic_hits?: number;
		misses?: number;
		hit_rate?: number;
	};
	composio?: { calls?: number };
	provider_health?: Record<string, RawProviderCircuitState>;
	provider_quota?: Record<string, RawProviderQuota>;
	providers?: {
		requests?: Record<string, number>;
		errors?: Record<string, number>;
	};
	requests?: {
		total?: number;
		errors?: number;
		rate_limited?: number;
		firewall_blocked?: number;
		budget_exceeded?: number;
		budget_notified?: number;
		budget_downgraded?: number;
		budget_restricted?: number;
	};
	tokens?: { input?: number; output?: number };
}

export interface RawStatus {
	health?: RawHealth | null;
	metrics?: RawMetrics | null;
	reachable?: boolean;
	url?: string | null;
}

function normalizeHealth(
	raw: RawHealth | null | undefined
): GatewayHealth | null {
	if (!raw) {
		return null;
	}
	return {
		status: raw.status ?? "unknown",
		version: raw.version ?? null,
		providers: raw.providers ?? [],
		authRequired: raw.auth_required ?? false,
	};
}

function normalizeMetrics(
	raw: RawMetrics | null | undefined
): GatewayMetrics | null {
	if (!raw) {
		return null;
	}
	const req = raw.requests ?? {};
	const cache = raw.cache ?? {};
	const tokens = raw.tokens ?? {};
	const providers = raw.providers ?? {};
	return {
		requests: {
			total: req.total ?? 0,
			errors: req.errors ?? 0,
			rateLimited: req.rate_limited ?? 0,
			firewallBlocked: req.firewall_blocked ?? 0,
			budgetExceeded: req.budget_exceeded ?? 0,
			budgetNotified: req.budget_notified ?? 0,
			budgetDowngraded: req.budget_downgraded ?? 0,
			budgetRestricted: req.budget_restricted ?? 0,
		},
		cache: {
			exactHits: cache.exact_hits ?? 0,
			semanticHits: cache.semantic_hits ?? 0,
			misses: cache.misses ?? 0,
			hitRate: cache.hit_rate ?? 0,
		},
		tokens: {
			input: tokens.input ?? 0,
			output: tokens.output ?? 0,
		},
		composioCalls: raw.composio?.calls ?? 0,
		providers: {
			requests: providers.requests ?? {},
			errors: providers.errors ?? {},
		},
		providerHealth: normalizeProviderHealth(raw.provider_health),
		providerQuota: normalizeProviderQuota(raw.provider_quota),
	};
}

function normalizeProviderQuota(
	raw: Record<string, RawProviderQuota> | undefined
): GatewayMetrics["providerQuota"] {
	if (!raw) {
		return {};
	}
	const result: Record<string, ProviderQuota> = {};
	for (const [name, q] of Object.entries(raw)) {
		result[name] = {
			remaining: q.remaining ?? null,
			limit: q.limit ?? null,
			resetAt: q.reset_at ?? null,
			resetInSecs: q.reset_in_secs ?? null,
			retryAfter: q.retry_after ?? null,
			rateLimited: q.rate_limited ?? false,
			updatedAt: q.updated_at ?? null,
		};
	}
	return result;
}

function normalizeCircuit(
	raw: string | undefined
): "closed" | "open" | "half_open" {
	if (raw === "open" || raw === "half_open") {
		return raw;
	}
	return "closed";
}

function normalizeProviderHealth(
	raw: Record<string, RawProviderCircuitState> | undefined
): GatewayMetrics["providerHealth"] {
	if (!raw) {
		return {};
	}
	const result: Record<string, ProviderCircuitState> = {};
	for (const [name, state] of Object.entries(raw)) {
		result[name] = {
			circuit: normalizeCircuit(state.circuit),
			consecutiveFailures: state.consecutive_failures ?? 0,
			openForSecs: state.open_for_secs ?? null,
		};
	}
	return result;
}

/**
 * Fetch combined Gateway status via Core's proxy (`/api/gateway/status`).
 *
 * Resolves to `{ reachable: false }` when the gateway is down but Core is up;
 * rejects only when Core itself is unreachable (so the status spine can tell the
 * two apart).
 */
export async function fetchGatewayStatus(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<GatewayStatus> {
	const json = await request<RawStatus>(
		target,
		"/api/gateway/status",
		{
			signal,
		},
		rawStatusResponseSchema
	);
	return {
		reachable: json.reachable ?? false,
		url: json.url ?? null,
		health: normalizeHealth(json.health),
		metrics: normalizeMetrics(json.metrics),
	};
}
