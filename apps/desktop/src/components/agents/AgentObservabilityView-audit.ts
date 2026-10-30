import { usageProviderLabel } from "@ryu/blocks/desktop/usage-analytics.ts";
import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import type { AuditEntry } from "@/src/lib/api/gateway.ts";
import type { RunSpan } from "@/src/lib/api/runs.ts";

export type ObservabilityFilter = "all" | "errors" | "slow" | "model" | "tool";
export type ObservabilityWindow = "1h" | "24h" | "7d" | "all";

export const REFRESH_INTERVAL_MS = 15_000;
const SLOW_REQUEST_MS = 1000;

export function windowStart(value: ObservabilityWindow): string | undefined {
	const durationMs = {
		"1h": 60 * 60 * 1000,
		"24h": 24 * 60 * 60 * 1000,
		"7d": 7 * 24 * 60 * 60 * 1000,
		all: 0,
	}[value];
	return durationMs === 0
		? undefined
		: new Date(Date.now() - durationMs).toISOString();
}

export function windowLabel(value: ObservabilityWindow): string {
	return {
		"1h": "Last hour",
		"24h": "Last 24 hours",
		"7d": "Last 7 days",
		all: "All available",
	}[value];
}

export interface ObservabilitySummary {
	averageLatencyMs: number | null;
	costMicroUsd: number;
	errorCount: number;
	promptCacheHitRate: number | null;
	promptCacheHitRequests: number;
	promptCacheMissRequests: number;
	promptCacheReadTokens: number | null;
	promptCacheWriteTokens: number | null;
	qualityScore: number | null;
	totalCacheMissTokens: number | null;
	totalCacheReadTokens: number | null;
	totalCacheWriteTokens: number | null;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalRequests: number;
}

/** A zero read count is a miss only when this request had a cache policy. */
export function promptCacheStatus(entry: AuditEntry): string | null {
	const readTokens = isNativeNumber(entry.prompt_cache_read_tokens)
		? entry.prompt_cache_read_tokens
		: null;
	const writeTokens = isNativeNumber(entry.prompt_cache_write_tokens)
		? entry.prompt_cache_write_tokens
		: null;
	const policyEnabled =
		isNativeText(entry.prompt_cache_outcome) &&
		entry.prompt_cache_outcome !== "disabled" &&
		entry.prompt_cache_outcome !== "below-minimum";

	if (readTokens !== null && readTokens > 0) {
		return writeTokens !== null && writeTokens > 0 ? "Hit + write" : "Hit";
	}
	if (readTokens === 0 && policyEnabled) {
		return writeTokens !== null && writeTokens > 0 ? "Miss + write" : "Miss";
	}
	if (writeTokens !== null && writeTokens > 0) {
		return "Cache write";
	}
	if (readTokens !== null || writeTokens !== null) {
		return "No cached tokens";
	}
	return null;
}

/** OpenRouter reports total prompt tokens plus cache reads and writes. The
 * residual is uncached input; other provider token semantics are not assumed. */
export function cacheMissTokens(entry: AuditEntry): number | null {
	if (
		entry.provider?.toLowerCase() !== "openrouter" ||
		!isNativeNumber(entry.input_tokens) ||
		!isNativeNumber(entry.cache_read_tokens) ||
		!isNativeNumber(entry.cache_write_tokens)
	) {
		return null;
	}
	return Math.max(
		0,
		entry.input_tokens - entry.cache_read_tokens - entry.cache_write_tokens
	);
}

/** Keep the dashboard's aggregate math deterministic and independently testable. */
export function summarizeAudit(entries: AuditEntry[]): ObservabilitySummary {
	const latencyValues = entries.flatMap((entry) =>
		entry.latency_ms !== null && entry.latency_ms >= 0 ? [entry.latency_ms] : []
	);
	const qualityValues = entries.flatMap((entry) =>
		entry.eval_score !== null && Number.isFinite(entry.eval_score)
			? [entry.eval_score]
			: []
	);
	const promptCacheReadValues = entries.flatMap((entry) =>
		isNativeNumber(entry.prompt_cache_read_tokens)
			? [entry.prompt_cache_read_tokens]
			: []
	);
	const promptCacheWriteValues = entries.flatMap((entry) =>
		isNativeNumber(entry.prompt_cache_write_tokens)
			? [entry.prompt_cache_write_tokens]
			: []
	);
	const promptCacheReadTokens =
		promptCacheReadValues.length > 0
			? promptCacheReadValues.reduce((sum, value) => sum + value, 0)
			: null;
	const promptCacheWriteTokens =
		promptCacheWriteValues.length > 0
			? promptCacheWriteValues.reduce((sum, value) => sum + value, 0)
			: null;
	const promptCacheActivity =
		(promptCacheReadTokens ?? 0) + (promptCacheWriteTokens ?? 0);
	const cacheReadValues = entries.flatMap((entry) =>
		isNativeNumber(entry.cache_read_tokens) ? [entry.cache_read_tokens] : []
	);
	const cacheWriteValues = entries.flatMap((entry) =>
		isNativeNumber(entry.cache_write_tokens) ? [entry.cache_write_tokens] : []
	);
	const cacheMissValues = entries.flatMap((entry) => {
		const missTokens = cacheMissTokens(entry);
		return missTokens === null ? [] : [missTokens];
	});
	return {
		averageLatencyMs:
			latencyValues.length > 0
				? latencyValues.reduce((sum, value) => sum + value, 0) /
					latencyValues.length
				: null,
		promptCacheHitRate:
			promptCacheActivity > 0
				? (promptCacheReadTokens ?? 0) / promptCacheActivity
				: null,
		promptCacheHitRequests: entries.filter(
			(entry) => (entry.prompt_cache_read_tokens ?? 0) > 0
		).length,
		promptCacheMissRequests: entries.filter((entry) =>
			promptCacheStatus(entry)?.startsWith("Miss")
		).length,
		promptCacheReadTokens,
		promptCacheWriteTokens,
		costMicroUsd: entries.reduce(
			(sum, entry) => sum + (entry.cost_micro_usd ?? 0),
			0
		),
		errorCount: entries.filter((entry) => Boolean(entry.error)).length,
		qualityScore:
			qualityValues.length > 0
				? qualityValues.reduce((sum, value) => sum + value, 0) /
					qualityValues.length
				: null,
		totalInputTokens: entries.reduce(
			(sum, entry) => sum + (entry.input_tokens ?? 0),
			0
		),
		totalOutputTokens: entries.reduce(
			(sum, entry) => sum + (entry.output_tokens ?? 0),
			0
		),
		totalCacheReadTokens:
			cacheReadValues.length > 0
				? cacheReadValues.reduce((sum, value) => sum + value, 0)
				: null,
		totalCacheWriteTokens:
			cacheWriteValues.length > 0
				? cacheWriteValues.reduce((sum, value) => sum + value, 0)
				: null,
		totalCacheMissTokens:
			cacheMissValues.length > 0
				? cacheMissValues.reduce((sum, value) => sum + value, 0)
				: null,
		totalRequests: entries.length,
	};
}

/** Filter only at the presentation boundary; the server remains the ACL owner. */
export function filterAuditEntries(
	entries: AuditEntry[],
	query: string,
	filter: ObservabilityFilter
): AuditEntry[] {
	const needle = query.trim().toLowerCase();
	return entries.filter((entry) => {
		if (filter === "errors" && !entry.error) {
			return false;
		}
		if (filter === "slow" && (entry.latency_ms ?? 0) < SLOW_REQUEST_MS) {
			return false;
		}
		if (filter === "model" && entry.event_type !== "model_call") {
			return false;
		}
		if (filter === "tool" && entry.event_type !== "exec_call") {
			return false;
		}
		if (!needle) {
			return true;
		}
		return [
			entry.command,
			entry.error,
			entry.feature,
			entry.model,
			entry.provider,
			entry.request_id,
			entry.session_id,
		]
			.filter((value): value is string => Boolean(value))
			.some((value) => value.toLowerCase().includes(needle));
	});
}

export function formatNumber(value: number): string {
	return new Intl.NumberFormat().format(value);
}

export function formatCost(microUsd: number): string {
	if (microUsd === 0) {
		return "$0.00";
	}
	return `$${(microUsd / 1_000_000).toFixed(4)}`;
}

export function formatScore(value: number | null): string {
	return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export function formatPercent(value: number | null): string {
	return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export const savedObservabilityViewSchema = z.object({
	filter: z.enum(["all", "errors", "slow", "model", "tool"]),
	id: z.string(),
	name: z.string(),
	query: z.string(),
	timeRange: z.enum(["1h", "24h", "7d", "all"]),
});
export type SavedObservabilityView = z.infer<
	typeof savedObservabilityViewSchema
>;

export interface DiscoverGroup {
	averageLatency: number | null;
	count: number;
	errorCount: number;
	key: string;
	percent: number;
}

export function discoverGroups(entries: AuditEntry[]): DiscoverGroup[] {
	const groups = new Map<string, AuditEntry[]>();
	for (const entry of entries) {
		const key = entry.error
			? `error · ${entry.error.slice(0, 72)}`
			: `${entry.provider ? usageProviderLabel(entry.provider) : entry.provider} · ${entry.model}`;
		const group = groups.get(key) ?? [];
		group.push(entry);
		groups.set(key, group);
	}
	return Array.from(groups.entries())
		.map(([key, group]) => {
			const latency = group
				.map((entry) => entry.latency_ms)
				.filter((value): value is number => value !== null);
			return {
				averageLatency:
					latency.length > 0
						? latency.reduce((sum, value) => sum + value, 0) / latency.length
						: null,
				count: group.length,
				errorCount: group.filter((entry) => Boolean(entry.error)).length,
				key,
				percent: entries.length > 0 ? group.length / entries.length : 0,
			};
		})
		.sort((left, right) => right.count - left.count)
		.slice(0, 8);
}

export function savedViewsKey(agentId: string): string {
	return `ryu-observability-views:${agentId}`;
}

export function spanDuration(span: RunSpan): string {
	if (span.endedAt === null) {
		return "in flight";
	}
	const duration = Math.max(0, span.endedAt - span.startedAt);
	return duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`;
}
