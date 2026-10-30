import type {
	AutoScoringWeights,
	GatewayRoutingConfig,
	PoolExecutionConfig,
} from "@/src/lib/api/gateway.ts";

export type Pool = NonNullable<GatewayRoutingConfig["provider_pools"]>[string];
export type PoolMember = Pool["members"][number];
export type DraftMember = PoolMember & { id: string };

export const STRATEGIES: { value: Pool["strategy"]; label: string }[] = [
	{ value: "priority", label: "Priority" },
	{ value: "round_robin", label: "Round robin" },
	{ value: "weighted_round_robin", label: "Weighted round robin" },
	{ value: "random", label: "Random" },
	{ value: "least_used", label: "Least used" },
	{ value: "weighted", label: "Weighted" },
	{ value: "fill_first", label: "Fill first" },
	{ value: "p2c", label: "Power of two choices" },
	{ value: "strict_random", label: "Strict random" },
	{ value: "cost_optimized", label: "Cost optimized" },
	{ value: "headroom", label: "Headroom" },
	{ value: "reset_window", label: "Reset window" },
	{ value: "reset_aware", label: "Reset aware" },
	{ value: "context_relay", label: "Context relay" },
	{ value: "context_optimized", label: "Context optimized" },
	{ value: "cache_optimized", label: "Cache optimized" },
	{ value: "lkgp", label: "Last known good provider" },
	{ value: "auto", label: "Auto" },
	{ value: "fusion", label: "Fusion" },
	{ value: "pipeline", label: "Pipeline" },
	{ value: "quota_weighted", label: "Quota weighted" },
];

export const EXECUTION_FIELDS: {
	key: keyof PoolExecutionConfig;
	label: string;
	minimum: number;
	maximum: number;
}[] = [
	{
		key: "leg_timeout_ms",
		label: "Per-target timeout (ms)",
		minimum: 1,
		maximum: 30_000,
	},
	{
		key: "total_timeout_ms",
		label: "Total timeout (ms)",
		minimum: 1,
		maximum: 120_000,
	},
	{
		key: "max_output_bytes",
		label: "Output limit (bytes)",
		minimum: 1,
		maximum: 262_144,
	},
	{ key: "quorum", label: "Response quorum", minimum: 1, maximum: 8 },
	{ key: "grace_ms", label: "Quorum grace (ms)", minimum: 0, maximum: 5000 },
];

export const AUTO_WEIGHT_FIELDS: {
	key: keyof AutoScoringWeights;
	label: string;
}[] = [
	{ key: "quota", label: "Quota" },
	{ key: "health", label: "Health" },
	{ key: "cost_inv", label: "Inverse cost" },
	{ key: "latency_inv", label: "Inverse latency" },
	{ key: "task_fit", label: "Task fit" },
	{ key: "stability", label: "Stability" },
	{ key: "tier_priority", label: "Tier priority" },
	{ key: "tier_affinity", label: "Tier affinity" },
	{ key: "specificity_match", label: "Specificity match" },
	{ key: "context_affinity", label: "Context affinity" },
	{ key: "cache_affinity", label: "Cache affinity" },
	{ key: "session_availability", label: "Session availability" },
	{ key: "reset_window_affinity", label: "Reset-window affinity" },
	{ key: "connection_density", label: "Connection density" },
	{ key: "quality", label: "Quality" },
	{ key: "reliability", label: "Reliability" },
];

export function strategyLabel(strategy: Pool["strategy"]): string {
	return STRATEGIES.find((item) => item.value === strategy)?.label ?? strategy;
}
