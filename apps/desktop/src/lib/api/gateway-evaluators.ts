import type { GatewayFirewallPolicy } from "@ryuhq/core-client/gateway.ts";
import { type ApiTarget, request } from "./client.ts";
import type { InspectorConfig } from "./gateway-classify-tier.ts";
import type {
	CustomPattern,
	GatewayAlertTier,
} from "./gateway-routing-config.ts";
import { fetchEvaluatorsResponseSchema } from "./gateway-status-response-contracts.ts";

// ── Unified evaluator taxonomy (one catalog: inline guardrails + offline evals) ─
//
// Mirrors the gateway `evaluators` module wire shapes. IMPORTANT casing: the
// evaluator FAMILY serializes camelCase (`inlineAction`, `judgeModel`,
// `higherIsBetter`, `impl`, `meanScore`, …); the CONTAINERS they ride
// (`custom_evaluators`, `firewall.evaluators`, and the eval `CaseScore` body)
// stay snake_case, matching the surrounding firewall/evals types.

/** Catalog section (matches the product screenshot's tabs; snake_case wire). */
export type EvaluatorCategory =
	| "security"
	| "safety"
	| "quality"
	| "conversation"
	| "trajectory"
	| "image"
	| "voice"
	| "custom";

/** What an evaluator judges (snake_case wire). */
export type EvaluatorTarget =
	| "input"
	| "output"
	| "conversation"
	| "trajectory"
	| "image"
	| "audio";

/** Language for a Code evaluator (snake_case wire). */
export type EvaluatorCodeLang = "js" | "python";

/** First-class gate: which surfaces may offer this evaluator. */
export interface EvaluatorCapabilities {
	/** May run inline as a request/response guardrail. */
	inline: boolean;
	/** May run offline over a dataset case. */
	offline: boolean;
}

/**
 * How an evaluator computes its judgment (discriminated on the snake_case
 * `kind`, mirroring the gateway `EvaluatorImpl` internally-tagged enum).
 */
export type EvaluatorImpl =
	| { kind: "regex"; patterns: string[] }
	| { kind: "heuristic" }
	| { kind: "llm_judge"; rubric: string }
	| { kind: "code"; lang: EvaluatorCodeLang; source: string }
	| { kind: "builtin"; detector: string };

/** Inline-guardrail config carried on a catalog entry (camelCase wire). */
export interface EvaluatorInlineConfig {
	/** `block | warn_and_continue | sanitize`. */
	action: GatewayFirewallPolicy;
}

/** Offline-eval config: pass threshold + optional judge model override. */
export interface EvaluatorOfflineConfig {
	/** Judge model override; omit/null routes through the default router. */
	judgeModel?: string | null;
	/** Score in [0,1] at/above which the case passes. */
	threshold: number;
}

/**
 * A single evaluator: one entry in the shared catalog (mirrors gateway
 * `Evaluator`, camelCase). `enforced` is the honesty flag — `true` only when the
 * detector is wired to real inline execution; a `false` entry can be catalogued
 * (and enabled) but does nothing yet, and the UI must say so.
 */
export interface Evaluator {
	/** `true` for shipped seed entries; `false` for user-created ("from scratch"). */
	builtin: boolean;
	capabilities: EvaluatorCapabilities;
	category: EvaluatorCategory;
	description: string;
	/** Honesty flag: `true` once wired to real execution. */
	enforced: boolean;
	/** Score polarity: `true` ⇒ higher is better (quality); `false` ⇒ higher is worse. */
	higherIsBetter: boolean;
	id: string;
	/** Serialized under the reserved key `impl`. */
	impl: EvaluatorImpl;
	inline?: EvaluatorInlineConfig | null;
	name: string;
	offline?: EvaluatorOfflineConfig | null;
	target: EvaluatorTarget;
}

/**
 * A per-scope override for one catalog evaluator, cascaded node → org → agent by
 * the firewall resolver with the same union + lock semantics as the firewall
 * dials (mirrors gateway `EvaluatorBinding`, camelCase). Rides
 * `firewall.evaluators` / the overlay `evaluators` list.
 */
export interface EvaluatorBinding {
	/** Whether this evaluator is enabled at this scope. */
	enabled: boolean;
	/** Stable id of the catalog evaluator this binding configures. */
	id: string;
	/** Inline-guardrail action when enabled inline; omit if not offered inline. */
	inlineAction?: GatewayFirewallPolicy | null;
	/** Freeze so a narrower scope can only tighten it, never loosen. */
	locked?: boolean;
	/** Offline-eval config (threshold + judge model) when enabled offline. */
	offline?: EvaluatorOfflineConfig | null;
}

/**
 * Result of scoring one registry evaluator against a single case's response
 * (mirrors gateway `EvaluatorScore`, camelCase-wrapped inside the snake_case
 * `CaseScore.evaluators` list).
 */
export interface EvaluatorScore {
	/** The evaluator's category (snake_case), e.g. "security", "quality". */
	category: string;
	/** Human-readable explanation (match text, judge verdict, or skip reason). */
	detail: string;
	/** Honesty flag: `true` only when a real score was computed. */
	executed: boolean;
	/** Stable id of the catalog evaluator that produced this score. */
	id: string;
	/** Whether this case passed the evaluator. */
	pass: boolean;
	/** Score in [0,1]. Higher = better for quality; 1.0 = clean for safety regex. */
	score: number;
}

/** Per-evaluator aggregate across all cases in a run (mirrors gateway `EvaluatorAggregate`). */
export interface EvaluatorAggregate {
	/** Number of cases where the evaluator actually executed. */
	executedCount: number;
	/** Mean `score` over cases where the evaluator executed. */
	meanScore: number;
	/** Fraction of executed cases that passed. */
	passRate: number;
}

/**
 * Fetch the full evaluator catalog via Core's proxy
 * (`GET /api/gateway/evaluators`) — the built-in seed table merged with any
 * user-authored custom evaluators (custom entries report `builtin: false`).
 * This is BOTH the catalog source and the read side for the custom set
 * (filter `builtin === false`); the redacted `/v1/config` does not carry it.
 */
export async function fetchEvaluators(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<Evaluator[]> {
	const raw = await request<{ evaluators?: Evaluator[] }>(
		target,
		"/api/gateway/evaluators",
		{ signal },
		fetchEvaluatorsResponseSchema
	);
	return raw.evaluators ?? [];
}

/** Firewall config shape (mirrors gateway FirewallConfig exactly). */
export interface GatewayFirewallConfig {
	/**
	 * Notification fan-out tier when the firewall matches — orthogonal to
	 * `policy`, which is the enforcement action. Optional on the wire (older
	 * gateways omit it and the Rust field is `#[serde(default)]`); treat
	 * `undefined` as `"silent"`. {@link fetchGatewayConfig} coalesces it so the
	 * card always has a concrete value to bind a Select to.
	 */
	alert?: GatewayAlertTier;
	/**
	 * User-defined patterns merged on top of the curated built-in sets. Optional
	 * on the wire: older gateways omit it, so treat `undefined` as `[]`.
	 */
	custom_patterns?: CustomPattern[];
	enabled: boolean;
	/**
	 * Per-scope evaluator bindings that ride the firewall cascade (node base).
	 * Optional on the wire: older gateways omit it, so treat `undefined` as `[]`.
	 */
	evaluators?: EvaluatorBinding[];
	/**
	 * Optional cheap-LLM inspector carried on the node base. Older gateways omit
	 * it, so treat `undefined` as the disabled default.
	 */
	inspector?: InspectorConfig;
	/**
	 * Field names this (node) scope freezes so a narrower scope can only tighten
	 * them. Optional on the wire; treat `undefined` as `[]`.
	 */
	locked_fields?: string[];
	log_detections: boolean;
	policy: GatewayFirewallPolicy;
	/** Redact PII patterns (email, phone, SSN, etc.) when policy = sanitize. */
	redact_pii: boolean;
	/** Redact secret patterns (API keys, tokens, PEM keys) when policy = sanitize. */
	redact_secrets: boolean;
	scan_inbound: boolean;
	scan_outbound: boolean;
	/**
	 * Wrap untrusted tool results re-entering the model in boundary markers
	 * (injection defense). A node-level process global; per-scope overrides do
	 * not reach the tool loop in v1. Optional on the wire.
	 */
	wrap_untrusted_tool_results?: boolean;
}

/**
 * A partial FirewallConfig applied over a broader scope in the node → org →
 * agent cascade (mirrors gateway `FirewallOverlay`). Every scalar is optional:
 * a present value overrides the inherited one; `undefined`/`null` inherits.
 * `custom_patterns` are appended (union, never replace); `locked_fields` freeze
 * a field so a narrower scope can only tighten it. Wire keys are snake_case.
 */
/** The desktop's fail-soft config view also supports an omitted legacy firewall. */
export interface GatewayFirewallView extends Partial<GatewayFirewallConfig> {
	alert: GatewayAlertTier;
	custom_patterns: CustomPattern[];
	inspector: InspectorConfig;
	locked_fields: string[];
}

export interface GatewayFirewallOverlay {
	/**
	 * Per-scope alert tier. `null`/`undefined` inherits the broader scope's tier.
	 *
	 * The gateway half is in place: `FirewallOverlay.alert: Option<AlertTier>`
	 * (`apps/gateway/src/config.rs`) plus its arm in `apply_overlay`
	 * (`apps/gateway/src/firewall/resolve.rs`). An earlier revision of this comment
	 * described both as pending and concluded several things from their absence;
	 * all of that is superseded, and the two conclusions worth correcting by name:
	 *
	 * LOCKABLE — yes. The `apply_overlay` arm honours a lock via `louder_alert` =
	 * `max` over `AlertTier`'s ascending-severity `Ord`, so with `"alert"` in a
	 * broader scope's `locked_fields` a narrower scope may only RAISE the tier.
	 * `"alert"` is a canonical name on `FirewallConfig::locked_fields`, and
	 * `GuardrailAlertRow` offers the node-scope toggle. It is not in
	 * `default_firewall_locked_fields`: a notification dial is not a protection
	 * dial, so it starts unlocked.
	 *
	 * COVERAGE — partial, and the boundary is NOT inbound-vs-outbound. Enumerated
	 * from the `firewall_policy_alert` call sites across `apps/gateway/src/pipeline/`:
	 *
	 * - Scope-aware, via `state.resolved_scanner(ctx)` → `scanner.config()`:
	 *   `pre_process` (inbound text), `apply_inline_input_evaluators`, and
	 *   `apply_inline_output_evaluators` — the last of which raises OUTBOUND blocks,
	 *   so an org/agent tier does govern those.
	 * - Node-base only, via `state.with_firewall(|fw| … fw.config() …)`: `run`'s
	 *   stage-9 outbound response scan, `run_multimodal`'s inbound scan, and
	 *   `submit_video_job`'s inbound scan. An overlay tier is ignored at all three;
	 *   the node tier fires.
	 *
	 * So UI copy must not promise that an org/agent tier governs image or video
	 * requests, nor that it is powerless on outbound. Only the node scope covers
	 * all six sites. Widening the three is a `pipeline/` change.
	 */
	alert?: GatewayAlertTier | null;
	custom_patterns?: CustomPattern[];
	enabled?: boolean | null;
	/**
	 * Per-scope evaluator bindings for this overlay. Appended (union) onto the
	 * broader scope's bindings; a binding a broader scope locked cannot be
	 * loosened. Optional on the wire.
	 */
	evaluators?: EvaluatorBinding[];
	inspector?: InspectorConfig | null;
	locked_fields?: string[];
	log_detections?: boolean | null;
	policy?: GatewayFirewallPolicy | null;
	redact_pii?: boolean | null;
	redact_secrets?: boolean | null;
	scan_inbound?: boolean | null;
	scan_outbound?: boolean | null;
	wrap_untrusted_tool_results?: boolean | null;
}
