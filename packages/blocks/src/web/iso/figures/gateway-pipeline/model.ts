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

import { formatNumberValue } from "@ryu/i18n/format-intl";
import type { LiteralMessage } from "@ryu/i18n/react";

export interface Stage {
	/** One plain sentence, for the slider's value text. */
	does: (tl: LiteralMessage, locale?: string) => string;
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

export const STAGES: readonly Stage[] = [
	{
		id: "rate-limit",
		pinned: true,
		does: (tl, locale) =>
			tl(
				"Pinned first. Each key gets {requestsPerMinute} requests and {tokensPerMinute} tokens a minute by default, and bursts above {burstPerSecond} requests a second trip it; an over-limit request gets a {limitStatus}.",
				{
					burstPerSecond: BURST_PER_SECOND,
					limitStatus: LIMIT_STATUS,
					requestsPerMinute: REQUESTS_PER_MINUTE,
					tokensPerMinute: formatNumberValue(locale, TOKENS_PER_MINUTE),
				}
			),
	},
	{
		id: "firewall",
		pinned: true,
		does: (tl) =>
			tl(
				"Pinned and always on. Scans for prompt injection, secrets and personal data; blocks with {blockStatus} by default, or warns or redacts instead.",
				{ blockStatus: BLOCK_STATUS }
			),
	},
	{
		id: "inspector",
		pinned: false,
		does: (tl) =>
			tl(
				"Swappable. An optional model check of the request; if the check itself fails, the request goes on."
			),
	},
	{
		id: "inline-input",
		pinned: false,
		does: (tl) =>
			tl("Swappable. Runs the evaluator guardrails attached to request input."),
	},
	{
		id: "policy",
		pinned: false,
		does: (tl) =>
			tl(
				"Swappable. Enforces the organisation's approved models and locked guardrails."
			),
	},
	{
		id: "companion-dlp",
		pinned: false,
		does: (tl) =>
			tl(
				"Swappable. Redacts personal data and secrets from screen-captured text before it leaves."
			),
	},
	{
		id: "route",
		pinned: true,
		does: (tl) =>
			tl("Pinned. Chooses the provider and model the call goes to."),
	},
	{
		id: "audit",
		pinned: true,
		does: (tl) =>
			tl("Pinned last. Records the call once the provider has answered."),
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

export function spokenOf(
	index: number,
	tl: LiteralMessage,
	locale?: string
): string {
	const stage = stageAt(index);
	return tl("Stage {position} of {stageCount}, {stageId}. {does}", {
		does: stage.does(tl, locale),
		position: index + 1,
		stageCount: STAGE_COUNT,
		stageId: stage.id,
	});
}

/** Read to assistive tech in place of a caption; nothing here is drawn as text. */
export function describePipeline(tl: LiteralMessage): string {
	return tl(
		"Ryu Gateway's request pipeline: a request passes {stageCount} gates in a fixed order. Rate limits run first, the firewall can never be turned off, and audit always runs last. The four taller gates are pinned; the four lower ones can be reordered or turned off. The moving request is simulated, not live traffic.",
		{ stageCount: STAGE_COUNT }
	);
}
