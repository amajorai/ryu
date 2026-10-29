/**
 * The truth this figure draws: Ryu Gateway's request pipeline.
 *
 * Every stage name, its order, which stages are pinned, and every number in the figure's
 * spoken description comes from the Gateway source. Re-verified against the working tree
 * on 2026-10-21:
 *
 * - Eight stages in this order (`DEFAULT_ORDER`):
 *   apps/gateway/src/pipeline/stages.rs:95-104, kebab-case ids at stages.rs:79-86.
 * - Only inspector, inline-input, policy and companion-dlp can be reordered or disabled:
 *   stages.rs:69-74 (`reorderable`). Rate-limit, firewall, route and audit are pinned,
 *   the firewall can never be disabled and audit is always last: stages.rs:18-25.
 * - Rate-limit defaults per key: 500 requests a minute (config.rs:4443-4445),
 *   100,000 tokens a minute (config.rs:4439-4441), burst detection above
 *   10 requests a second (config.rs:4435-4437), all in apps/gateway/src/config.rs.
 * - Firewall policies Block (the default), WarnAndContinue and Sanitize:
 *   apps/gateway/src/config.rs:4285-4300.
 * - Status codes: a rate-limited request is a 429 (apps/gateway/src/error.rs:154-155),
 *   a firewall block is a 403 (error.rs:159-160).
 * - What each stage does, as dispatched by `pre_process`:
 *   `pre_process` in apps/gateway/src/pipeline/mod.rs (inspector fails open, policy
 *   model allowlist, companion DLP egress guard, route), with audit as the ordering
 *   anchor written after the provider answers.
 *
 * The drawing has no visible text. Pinned stages are drawn as taller gates and swappable
 * ones as lower gates. The moving request is a simulation of this mechanism (one request
 * walking the stages in order), never traffic, counts or rates from a real deployment.
 */

export interface Stage {
	/** One plain sentence, for the slider's value text. */
	does: string;
	/** Stable id, as `PipelineStage::as_str` spells it. */
	id: string;
	/** Pinned stages can never be moved; the rest can be reordered or switched off. */
	pinned: boolean;
}

export const REQUESTS_PER_MINUTE = 500;
export const TOKENS_PER_MINUTE = 100_000;
export const BURST_PER_SECOND = 10;
export const BLOCK_STATUS = 403;
export const LIMIT_STATUS = 429;

const grouped = (value: number) => value.toLocaleString("en-US");

export const STAGES: readonly Stage[] = [
	{
		id: "rate-limit",
		pinned: true,
		does: `Pinned first. Each key gets ${REQUESTS_PER_MINUTE} requests and ${grouped(TOKENS_PER_MINUTE)} tokens a minute by default, and bursts above ${BURST_PER_SECOND} requests a second trip it; an over-limit request gets a ${LIMIT_STATUS}.`,
	},
	{
		id: "firewall",
		pinned: true,
		does: `Pinned and always on. Scans for prompt injection, secrets and personal data; blocks with ${BLOCK_STATUS} by default, or warns or redacts instead.`,
	},
	{
		id: "inspector",
		pinned: false,
		does: "Swappable. An optional model check of the request; if the check itself fails, the request goes on.",
	},
	{
		id: "inline-input",
		pinned: false,
		does: "Swappable. Runs the evaluator guardrails attached to request input.",
	},
	{
		id: "policy",
		pinned: false,
		does: "Swappable. Enforces the organisation's approved models and locked guardrails.",
	},
	{
		id: "companion-dlp",
		pinned: false,
		does: "Swappable. Redacts personal data and secrets from screen-captured text before it leaves.",
	},
	{
		id: "route",
		pinned: true,
		does: "Pinned. Chooses the provider and model the call goes to.",
	},
	{
		id: "audit",
		pinned: true,
		does: "Pinned last. Records the call once the provider has answered.",
	},
];

export const STAGE_COUNT = STAGES.length;

export function stageAt(index: number): Stage {
	const stage = STAGES[Math.max(0, Math.min(STAGE_COUNT - 1, index))];
	if (!stage) {
		throw new Error("The pipeline has no stages.");
	}
	return stage;
}

export function spokenOf(index: number) {
	const stage = stageAt(index);
	return `Stage ${index + 1} of ${STAGE_COUNT}, ${stage.id}. ${stage.does}`;
}

/** Read to assistive tech in place of a caption; nothing here is drawn as text. */
export const DESCRIPTION = `Ryu Gateway's request pipeline: a request passes ${STAGE_COUNT} gates in a fixed order. Rate limits run first, the firewall can never be turned off, and audit always runs last. The four taller gates are pinned; the four lower ones can be reordered or turned off. The moving request is simulated, not live traffic.`;
