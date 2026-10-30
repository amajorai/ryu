import type { RyuJsonValue } from "@ryu/app-host/rpc";
import type {
	AssertionResult,
	EvalMessage,
	RedTeamStrategyResult,
} from "@ryuhq/core-client/gateway.ts";
import { type ApiTarget, request } from "./client.ts";
import { rawStatusResponseSchema8 } from "./gateway-audit-response-contracts.ts";
import type {
	EvaluatorAggregate,
	EvaluatorCodeLang,
	EvaluatorScore,
} from "./gateway-evaluators.ts";
import {
	type GatewayJsonValue,
	gatewayJsonValueSchema,
} from "./gateway-json-contracts.ts";
import {
	fetchClassifyWeightsPresentResponseSchema0,
	rawStatusResponseSchema9,
} from "./gateway-redteam-response-contracts.ts";

// ── Eval dataset runner (M4 / #180) ──────────────────────────────────────────
//
// Scorers: latency / token_efficiency / policy_pass / optional substring_match,
// plus promptfoo-style per-case assertions (deterministic + llm_judge),
// run-level system prompts, {{var}} substitution, and multi-model compare.

/** Promptfoo-compatible per-assertion controls. */
export interface AssertionOptions {
	config?: Record<string, GatewayJsonValue>;
	metric?: string;
	not?: boolean;
	provider?: string;
	rubric_prompt?: string;
	threshold?: number;
	transform?: string;
	weight?: number;
}

/** One assertion to evaluate against a case's response (internally tagged on kind). */
export type Assertion =
	| { kind: "contains"; options?: AssertionOptions; value: string }
	| { kind: "not_contains"; options?: AssertionOptions; value: string }
	| { kind: "equals"; options?: AssertionOptions; value: string }
	| { kind: "regex"; options?: AssertionOptions; value: string }
	| { kind: "icontains"; options?: AssertionOptions; value: string }
	| { kind: "starts_with"; options?: AssertionOptions; value: string }
	| { kind: "contains_any"; options?: AssertionOptions; value: string }
	| { kind: "contains_all"; options?: AssertionOptions; value: string }
	| { kind: "icontains_any"; options?: AssertionOptions; value: string }
	| { kind: "icontains_all"; options?: AssertionOptions; value: string }
	| { kind: "contains_json"; options?: AssertionOptions; value: string }
	| { kind: "contains_html"; options?: AssertionOptions; value: string }
	| { kind: "contains_xml"; options?: AssertionOptions; value: string }
	| { kind: "contains_sql"; options?: AssertionOptions; value: string }
	| { kind: "levenshtein"; options?: AssertionOptions; value: string }
	| { kind: "latency"; options?: AssertionOptions; value: string }
	| { kind: "cost"; options?: AssertionOptions; value: string }
	| {
			assertions: Assertion[];
			kind: "assert_set";
			options?: AssertionOptions;
	  }
	| { kind: "is_html"; options?: AssertionOptions }
	| { kind: "is_xml"; options?: AssertionOptions }
	| { kind: "is_sql"; options?: AssertionOptions }
	| { kind: "is_refusal"; options?: AssertionOptions }
	| { kind: "moderation"; options?: AssertionOptions; value: string }
	| { kind: "javascript"; options?: AssertionOptions; value: string }
	| { kind: "python"; options?: AssertionOptions; value: string }
	| { kind: "ruby"; options?: AssertionOptions; value: string }
	| { kind: "webhook"; options?: AssertionOptions; value: string }
	| { kind: "is_json"; options?: AssertionOptions }
	| { kind: "json_valid"; options?: AssertionOptions }
	| { kind: "llm_judge"; options?: AssertionOptions; rubric: string }
	| { kind: "llm_rubric"; options?: AssertionOptions; rubric: string }
	| { kind: "similar"; options?: AssertionOptions; value: string }
	| { kind: "factuality"; options?: AssertionOptions; rubric: string }
	| { kind: "context_faithfulness"; options?: AssertionOptions; rubric: string }
	| { kind: "answer_relevance"; options?: AssertionOptions; rubric: string };

/** A single case in an eval dataset. */
export interface EvalDatasetCase {
	/** Assertions to evaluate against this case's response. */
	assertions?: Assertion[];
	/** Optional reference/context payload for factuality and faithfulness checks. */
	context?: unknown;
	/** Human-readable case description. */
	description?: string;
	/**
	 * Registry evaluator ids to score this case against, in addition to any
	 * run-level ids. Empty by default => assertion-only behavior.
	 */
	evaluators?: string[];
	/**
	 * Optional expected substring. When present the gateway applies a
	 * case-insensitive contains check and adds a substring_match score.
	 * When absent the scorer is omitted — no penalty for a missing expected.
	 */
	expected?: string | null;
	/** Stable case id used in persisted result matrices. */
	id?: string;
	/** Optional ordered chat turns; when present the gateway replays these. */
	messages?: EvalMessage[];
	/** Case metadata preserved in results and exports. */
	metadata?: Record<string, GatewayJsonValue>;
	/** Promptfoo-compatible per-case prompt/output options. */
	options?: {
		cache?: boolean;
		prefix?: string;
		suffix?: string;
		timeout_ms?: number;
		transform?: string;
		transform_vars?: string;
	};
	/** The single-turn prompt fallback. May contain {{vars}}. */
	prompt: string;
	/** Optional per-case provider/model target. */
	provider?: string;
	/** Exact provider-reported row cost in micro-USD when the response omits it. */
	provider_cost_micro_usd?: number;
	/** Externally measured operation turnaround in milliseconds. */
	provider_latency_ms?: number;
	/** Precomputed provider output; skips a live provider call. */
	provider_output?: unknown;
	provider_output_policy_pass?: boolean;
	/** Source label for a precomputed provider response. */
	provider_output_provider?: string;
	/** Optional per-case provider/model alternatives. */
	providers?: string[];
	/** Promptfoo-style threshold for the mean assertion score (0..1). */
	threshold?: number;
	/** Per-case {{var}} substitutions (prompt, system prompt, assertions). */
	vars?: Record<string, GatewayJsonValue>;
}

/** Per-case scores returned by the gateway eval runner. */
export interface EvalCaseScore {
	/** Mean assertion score in [0,1], before the case threshold is applied. */
	assertion_score: number;
	/** NEW: per-assertion results (always present; [] when no assertions). */
	assertions: AssertionResult[];
	/** NEW: true iff every assertion passed (vacuously true for []). */
	assertions_pass: boolean;
	cache_hit?: boolean;
	/** Optional reference/context payload preserved for result inspection. */
	context?: unknown;
	cost_micro_usd?: number | null;
	description?: string;
	error?: string | null;
	/**
	 * Per-evaluator scores for the registry evaluators requested for this case.
	 * Present ([] when none requested). Additive to `overall`; never folded in.
	 */
	evaluators?: EvaluatorScore[];
	id?: string;
	input_tokens?: number;
	latency_available?: boolean;
	latency_ms?: number;
	/** 1.0 = instant, 0.0 = at/beyond max_latency_ms. */
	latency_score: number;
	metadata?: Record<string, RyuJsonValue>;
	model?: string;
	output_tokens?: number;
	/** Weighted aggregate for this case. Range [0, 1]. */
	overall: number;
	policy_available?: boolean;
	/** Whether the request passed all firewall/policy checks. */
	policy_pass: boolean;
	prompt: string;
	prompt_id?: string;
	provider?: string;
	rendered_prompt?: string;
	/** The response text the provider returned (or an error message). */
	response_text: string;
	/** Present only when the case had an expected value. */
	substring_match: number | null;
	/** Ratio output/input tokens clamped to [0,1]. */
	token_efficiency: number;
	total_tokens?: number;
	vars?: Record<string, RyuJsonValue>;
}

/** Aggregate summary across all eval cases. */
export interface EvalRunAggregate {
	assertion_pass_rate?: number;
	/**
	 * Per-evaluator aggregate keyed by evaluator id. Empty when no registry
	 * evaluators were requested. Values are camelCase (`meanScore`/`passRate`/
	 * `executedCount`) even though the parent key is snake_case.
	 */
	evaluators?: Record<string, EvaluatorAggregate>;
	latency_available_cases?: number;
	mean_latency: number;
	/** Mean overall score across all cases. Range [0, 1]. */
	mean_overall: number;
	/** Mean substring match across cases that had an expected value. null when none did. */
	mean_substring_match: number | null;
	mean_token_efficiency: number;
	policy_available_cases?: number;
	/** Fraction of cases where policy_pass was true. Range [0, 1]. */
	policy_pass_rate: number;
	total_cases: number;
	total_cost_micro_usd?: number | null;
	total_input_tokens?: number;
	total_output_tokens?: number;
}

/** One model's full result block in a multi-model run. */
export interface ModelEvalResult {
	aggregate: EvalRunAggregate;
	cases: EvalCaseScore[];
	model: string;
}

/** Response from POST /api/gateway/evals/run (via Core proxy). */
export interface EvalRunResult {
	/** Always the FIRST evaluated model's aggregate (back-compat). */
	aggregate: EvalRunAggregate;
	/** Always the FIRST evaluated model's cases (back-compat). */
	cases: EvalCaseScore[];
	finished_at?: string;
	/** Present ONLY on the multi-model path; absent on single-model. */
	models?: ModelEvalResult[];
	run_id?: string;
	started_at?: string;
	tags?: Record<string, string>;
}

/** Response from POST /api/gateway/redteam/run (via Core's proxy). */
export interface RedTeamRunResult {
	campaign_id: string;
	model: string;
	result?: EvalRunResult;
	strategies: RedTeamStrategyResult[];
	summary: {
		needs_attention: number;
		protected: number;
		total: number;
	};
}

/** One custom Code evaluator's source, run by Core (not forwarded to the gateway). */
export interface CodeEvaluatorSpec {
	/** Stable id — matched against the gateway's placeholder score / injected. */
	id: string;
	/** `"js" | "python"` (aliases accepted server-side). */
	lang: EvaluatorCodeLang;
	/** The user function source. */
	source: string;
}

/** Request body for POST /api/gateway/evals/run. */
export interface RunEvalsRequest {
	/** Optional agent id for per-agent budget tracking. */
	agent_id?: string | null;
	/** Reuse identical provider inputs within this run. */
	cache?: boolean;
	/**
	 * Custom Code evaluators. Pulled out by the Core proxy and run locally
	 * (Core's JS sandbox for JS, the sandbox backend for Python); their scores are merged into each
	 * case's `evaluators` list. Their ids do NOT need to appear in `evaluators`.
	 */
	code_evaluators?: CodeEvaluatorSpec[];
	/**
	 * Dataset to replay. When empty or absent the gateway uses its built-in
	 * 3-case dataset so the panel works on first run without any configuration.
	 */
	dataset?: EvalDatasetCase[];
	/**
	 * Registry evaluator ids applied to EVERY case (unioned with each case's own
	 * `evaluators`). Empty by default => assertion-only behavior. Code-evaluator
	 * ids belong in `code_evaluators`, not here.
	 */
	evaluators?: string[];
	/**
	 * Optional judge model override; a single fixed judge across all models.
	 * When unset, the server defaults to the first model in `models`.
	 */
	judge_model?: string;
	/** Maximum provider calls in flight. */
	max_concurrency?: number;
	/**
	 * Model to evaluate. Flows through the gateway router — no provider is
	 * hardcoded; the gateway config determines which provider is used.
	 */
	model?: string;
	/**
	 * Multi-model compare. When set, the whole dataset runs against each model
	 * and the response gains a per-model `models` breakdown.
	 */
	models?: string[];
	/** Run-level prompt prefix/suffix. */
	prefix?: string;
	/** Stable prompt variant id for result matrices. */
	prompt_id?: string;
	/** Repeat each dataset case this many times. */
	repeat?: number;
	suffix?: string;
	/** Run-level multi-turn prompt variant; rendered before each test case. */
	system_messages?: EvalMessage[];
	/**
	 * Run-level system prompt; the server prepends it as a system message per
	 * case and substitutes any {{vars}} using that case's `vars`.
	 */
	system_prompt?: string;
	/** Run tags preserved in the result envelope. */
	tags?: Record<string, string>;
	/** Per-provider call deadline in milliseconds. */
	timeout_ms?: number;
}

/**
 * Run a dataset eval against the gateway via Core's proxy
 * (POST /api/gateway/evals/run).
 *
 * Each prompt is replayed through the full gateway pipeline (firewall, routing,
 * provider call). Returns per-case scores and an aggregate summary.
 *
 * Rejects when Core is unreachable; returns a structured error when the gateway
 * is down (Core relays a 502).
 */
export async function runGatewayEvals(
	target: ApiTarget,
	req: RunEvalsRequest = {},
	signal?: AbortSignal
): Promise<EvalRunResult> {
	return await request<EvalRunResult>(
		target,
		"/api/gateway/evals/run",
		{
			method: "POST",
			body: gatewayJsonValueSchema.parse(req),
			signal,
		},
		rawStatusResponseSchema8
	);
}

/** Score a completed production output without replaying its provider call. */
export async function scoreGatewayOutput(
	target: ApiTarget,
	input: {
		agent_id?: string;
		assertions?: Assertion[];
		cost_micro_usd?: number;
		description?: string;
		evaluators?: string[];
		expected?: string;
		id?: string;
		latency_ms?: number;
		metadata?: Record<string, GatewayJsonValue>;
		model?: string;
		policy_pass?: boolean;
		prompt?: string;
		response: unknown;
		threshold?: number;
		vars?: Record<string, GatewayJsonValue>;
	},
	signal?: AbortSignal
): Promise<{ kind: "online_score"; score: EvalCaseScore; scored_at: string }> {
	return await request(
		target,
		"/api/gateway/evals/score",
		{
			method: "POST",
			body: gatewayJsonValueSchema.parse(input),
			signal,
		},
		rawStatusResponseSchema9
	);
}

/**
 * Run the closed, safe local red-team probe set through the same Gateway path
 * as production traffic. The server owns the probe prompts and evaluator
 * mapping so callers cannot silently widen the campaign's security scope.
 */
export async function runGatewayRedTeam(
	target: ApiTarget,
	input: {
		agent_id: string;
		model?: string;
		strategies?: string[];
	},
	signal?: AbortSignal
): Promise<RedTeamRunResult> {
	return await request<RedTeamRunResult>(
		target,
		"/api/gateway/redteam/run",
		{
			method: "POST",
			body: gatewayJsonValueSchema.parse(input),
			signal,
		},
		fetchClassifyWeightsPresentResponseSchema0
	);
}
