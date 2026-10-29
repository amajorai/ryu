import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
// apps/desktop/src/lib/api/routing.ts
//
// Typed client for Core's threshold model fallback (`/api/routing/*`) — the
// rules that say "when I'm nearly out of X, run Y instead".
//
// Two surfaces, one evaluator behind them:
//
//   GET /api/routing/advice  -> what the NEXT turn would do, given current
//                               headroom. Backs the composer's info bar.
//   GET/PUT /api/routing/policy -> the node's rule list, edited in the Gateway
//                               (node) settings dialog.
//
// `advice` is a pure read — asking never applies a rule — and it is the same
// evaluator, over the same cached signals, that the turn itself runs through in
// Core. That is the point: the bar cannot promise one thing and the turn do
// another. Signal reads are cached per source in Core (subscription windows 5
// min, provider balances 5 min, the Ryu $ wallet 60 s), so calling this once per
// turn costs a preference read and arithmetic, not vendor round-trips.

import { formatCurrency } from "@ryu/ui/lib/number-format.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { request } from "@/src/lib/api/client.ts";
import type { AgentSelection } from "@/src/lib/api/preferences.ts";

/** Which signal family a rule watches. Each carries its threshold in ITS unit. */
export type RoutingCondition =
	| { source: "ryu_credits"; below_usd: number }
	| { source: "provider_credits"; provider_id: string; below_usd: number }
	| {
			source: "subscription_window";
			/**
			 * The agent whose own login is watched (`acp:claude`, …). Empty for a
			 * provider-scoped rule: exactly one of `agent_id` / `provider_id` is set.
			 */
			agent_id: string;
			/**
			 * A Ryu subscription provider (`claude-pro-max`, …). Without
			 * `account_id` the rule watches the provider's account pool and fires
			 * only when every eligible account with a reading is below the
			 * threshold; with no reading at all it does not fire.
			 */
			provider_id?: string;
			/** One saved account of `provider_id`. Requires `provider_id`. */
			account_id?: string;
			/** Case-insensitive substring of the window label; "" = worst window. */
			window: string;
			/** Restrict to a model-scoped window (Claude's per-model weekly caps). */
			model?: string;
			remaining_below_percent: number;
	  };

/**
 * A fallback target. Deliberately the SAME `AgentSelection` every other
 * agent/model setting on this node uses, so the rule form is the existing
 * `AgentSelectionField` rather than a bespoke model dropdown — and so a rule can
 * express anything the composer's picker can. All-empty means "notify only,
 * change nothing".
 */
export type RoutingSelection = AgentSelection;

export interface RoutingRule {
	/** Only apply on turns run by these agents. Empty = any. */
	applies_to_agents: string[];
	enabled: boolean;
	/**
	 * What to run instead. Named `fallback`, not `then`: an object carrying a
	 * `then` key is treated as a promise by `await`, so a rule list would
	 * silently mis-resolve.
	 */
	fallback: RoutingSelection;
	id: string;
	/** Surface this rule in the composer info bar when it fires. */
	notify: boolean;
	when: RoutingCondition;
}

export interface RoutingPolicy {
	rules: RoutingRule[];
}

/**
 * The policy plus what a rule is allowed to name. `credit_providers` comes from
 * Core (which owns the balance readers) rather than a hand-copied list here —
 * only a few vendors expose a balance to an inference key, and a rule naming any
 * other provider would evaluate to "unknown" forever and read as broken.
 */
export interface RoutingPolicyView extends RoutingPolicy {
	credit_providers: string[];
}

/** How loudly a verdict speaks. `swap` is the only one that changes a turn. */
export type RoutingSeverity = "continue" | "warn" | "swap";

export interface RoutingTarget {
	agent_id: string;
	model: string;
}

/** The number behind a verdict, so the bar can show it. */
export interface RoutingSignalReading {
	label: string;
	threshold: number;
	unit: "usd" | "percent";
	value: number;
}

export interface RoutingAdvice {
	effective: RoutingTarget;
	original: RoutingTarget;
	reason?: string;
	rule_id?: string;
	severity: RoutingSeverity;
	signal?: RoutingSignalReading;
}

/** The empty selection — a notify-only rule. */
export function emptyRoutingSelection(): RoutingSelection {
	return {
		agent_id: "",
		provider: "",
		model: "",
		thinking_level: "",
		effort: "",
		access_mode: "",
	};
}

/**
 * What the next turn would do for `agentId` / `model`.
 *
 * Always resolves: Core answers 200 with `severity: "continue"` when no rule
 * fires, and a transport failure is treated the same way by the caller — a
 * routing check that cannot be made must never block or annotate a turn.
 */
export async function fetchRoutingAdvice(
	target: ApiTarget,
	agentId: string,
	model: string,
	atConversationStart: boolean
): Promise<RoutingAdvice> {
	const params = new URLSearchParams({
		agent_id: agentId,
		model,
		// A rule that swaps the AGENT only applies at a conversation start (an ACP
		// agent owns its session state), and Core applies that gate inside the
		// evaluator — so sending the flag is what makes the bar's prediction and
		// the turn's behaviour the same thing.
		at_conversation_start: String(atConversationStart),
	});
	return await request<RoutingAdvice>(
		target,
		`/api/routing/advice?${params}`,
		undefined,
		routingAdviceResponseCodec
	);
}

/** The node's rule list, plus the providers a credit rule may name. */
export async function fetchRoutingPolicy(
	target: ApiTarget
): Promise<RoutingPolicyView> {
	return await request<RoutingPolicyView>(
		target,
		"/api/routing/policy",
		undefined,
		routingPolicyViewResponseCodec
	);
}

/** Replace the node's rule list. Core drops its cached signal readings. */
export async function saveRoutingPolicy(
	target: ApiTarget,
	policy: RoutingPolicy
): Promise<void> {
	await request<unknown>(
		target,
		"/api/routing/policy",
		{
			method: "PUT",
			body: policy,
		},
		gatewayJsonValueSchema
	);
}

/** Format a reading for the info bar, in whichever unit it came in. */
export function formatRoutingSignal(signal: RoutingSignalReading): string {
	return signal.unit === "usd"
		? formatCurrency(signal.value, "USD", {
				maximumFractionDigits: 2,
				minimumFractionDigits: 2,
			})
		: `${Math.round(signal.value)}%`;
}

// ── Reactive failover ───────────────────────────────────────────────────────
//
// The sibling of the rules above, and a different question. A rule is proactive
// ("when Claude's weekly drops under 50%, start using Sonnet") and fires before
// a turn on a threshold you chose. This fires AFTER a turn failed, on no rule at
// all: your agent hit its cap, so run the turn on whichever plan you already pay
// for still has room. Off by default.

/** The node's reactive failover config. */
export interface RetryPolicy {
	/**
	 * Restrict failover to these agent ids, in PREFERENCE ORDER (not merely a
	 * filter — listing Codex before Copilot states a priority that beats a raw
	 * headroom comparison). Empty = any subscription agent Core can read.
	 */
	candidates: string[];
	/** Off by default: a node that never opts in behaves exactly as today. */
	enabled: boolean;
	/**
	 * Explain, never reroute. The turn still fails, but you are told which plan
	 * had room instead of getting a bare vendor error. The setting to try first.
	 */
	notify_only: boolean;
	/** Percent-left below which a window counts as spent. Defaults to 2. */
	spent_below_percent: number;
}

/**
 * The config plus the agents a `candidates` list may name. The pool comes from
 * Core (which owns the window readers) rather than a hand-copied list here: only
 * five vendors expose a readable subscription window, and naming any other agent
 * would produce a fallback that can never report headroom.
 */
export interface RetryPolicyView {
	policy: RetryPolicy;
	subscription_agents: string[];
}

/**
 * What Core decided about a failed turn, delivered as a `data-ryu-failover`
 * message part. `stand` never reaches a client — it means the failure was not a
 * cap and nothing was added to the stream.
 *
 * This is the MACHINE-READABLE record, not the display path. Core also emits the
 * same verdict's `note` as an ordinary text block, because `/api/chat/stream` is
 * not desktop-only — the TUI, native app and island all POST to it and none of
 * them renders `data-*` frames, so a data-part-only explanation would let those
 * surfaces receive an answer from a different subscription with no indication.
 * Nothing renders this type today; it exists so tooling can read the structured
 * fields (which plan, how much headroom, when the window reopens) without
 * parsing the sentence.
 */
export type FailoverVerdict =
	| { kind: "stand" }
	| {
			kind: "reroute";
			agent_id: string;
			/** Percent left on that agent's tightest gating window. */
			headroom_percent: number;
			note: string;
	  }
	| {
			kind: "wait";
			/** The agent whose window reopens first. */
			agent_id: string;
			/** RFC3339. */
			resets_at: string;
			note: string;
	  }
	| {
			kind: "held";
			/** The agent that would have taken the turn. */
			agent_id: string;
			headroom_percent: number;
			note: string;
	  }
	| { kind: "no_candidate"; note: string };

/** The default config — what a node that never opted in behaves as. */
export function defaultRetryPolicy(): RetryPolicy {
	return {
		enabled: false,
		notify_only: false,
		candidates: [],
		spent_below_percent: 2,
	};
}

/** The node's reactive failover config, plus the agents it may name. */
export async function fetchRetryPolicy(
	target: ApiTarget
): Promise<RetryPolicyView> {
	return await request<RetryPolicyView>(
		target,
		"/api/routing/retry-policy",
		undefined,
		retryPolicyViewResponseCodec
	);
}

/** Replace the node's reactive failover config. */
export async function saveRetryPolicy(
	target: ApiTarget,
	policy: RetryPolicy
): Promise<void> {
	await request<unknown>(
		target,
		"/api/routing/retry-policy",
		{
			method: "PUT",
			body: policy,
		},
		gatewayJsonValueSchema
	);
}

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
const routingTargetResponseCodec = z
	.object({ agent_id: z.string(), model: z.string() })
	.catchall(gatewayJsonValueSchema);
const routingSeverityResponseCodec = z.union([
	z.literal("continue"),
	z.literal("warn"),
	z.literal("swap"),
]);
const routingSignalReadingResponseCodec = z
	.object({
		label: z.string(),
		threshold: z.number(),
		unit: z.union([z.literal("usd"), z.literal("percent")]),
		value: z.number(),
	})
	.catchall(gatewayJsonValueSchema);
const routingAdviceResponseCodec = z
	.object({
		effective: routingTargetResponseCodec,
		original: routingTargetResponseCodec,
		reason: z.string().optional(),
		rule_id: z.string().optional(),
		severity: routingSeverityResponseCodec,
		signal: routingSignalReadingResponseCodec.optional(),
	})
	.catchall(gatewayJsonValueSchema);
const agentSelectionResponseCodec = z
	.object({
		access_mode: z.string(),
		agent_id: z.string(),
		effort: z.string(),
		model: z.string(),
		provider: z.string(),
		thinking_level: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
const routingSelectionResponseCodec = agentSelectionResponseCodec;
const routingConditionResponseCodec = z.union([
	z
		.object({ source: z.literal("ryu_credits"), below_usd: z.number() })
		.catchall(gatewayJsonValueSchema),
	z
		.object({
			source: z.literal("provider_credits"),
			provider_id: z.string(),
			below_usd: z.number(),
		})
		.catchall(gatewayJsonValueSchema),
	z
		.object({
			source: z.literal("subscription_window"),
			agent_id: z.string(),
			window: z.string(),
			model: z.string().optional(),
			remaining_below_percent: z.number(),
		})
		.catchall(gatewayJsonValueSchema),
]);
const routingRuleResponseCodec = z
	.object({
		applies_to_agents: z.array(z.string()),
		enabled: z.boolean(),
		fallback: routingSelectionResponseCodec,
		id: z.string(),
		notify: z.boolean(),
		when: routingConditionResponseCodec,
	})
	.catchall(gatewayJsonValueSchema);
const routingPolicyResponseCodec = z
	.object({ rules: z.array(routingRuleResponseCodec) })
	.catchall(gatewayJsonValueSchema);
const routingPolicyViewResponseCodec = z.intersection(
	routingPolicyResponseCodec,
	z
		.object({ credit_providers: z.array(z.string()) })
		.catchall(gatewayJsonValueSchema)
);
const retryPolicyResponseCodec = z
	.object({
		candidates: z.array(z.string()),
		enabled: z.boolean(),
		notify_only: z.boolean(),
		spent_below_percent: z.number(),
	})
	.catchall(gatewayJsonValueSchema);
const retryPolicyViewResponseCodec = z
	.object({
		policy: retryPolicyResponseCodec,
		subscription_agents: z.array(z.string()),
	})
	.catchall(gatewayJsonValueSchema);
