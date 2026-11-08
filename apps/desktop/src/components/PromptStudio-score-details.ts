// Prompt Studio per-cell score detail lines. Each state is a whole message, so a
// translated cell never embeds an English "hit", "miss", "unknown" or "N/A".

import type { LiteralMessage } from "@ryu/i18n/react";
import { formatMicroUsd, formatNumber } from "@ryu/ui/lib/number-format.ts";
import type { EvalCaseScore } from "@/src/lib/api/gateway.ts";
import { pct } from "./PromptStudio-format.ts";

type ScoreDetailInput = Pick<
	EvalCaseScore,
	| "cache_hit"
	| "cost_micro_usd"
	| "latency_available"
	| "latency_score"
	| "total_tokens"
>;

/** The latency, tokens, cost and cache lines shown under a scored cell. */
export function scoreDetailLines(
	score: ScoreDetailInput,
	tl: LiteralMessage,
	locale?: string
): [latency: string, tokens: string, cost: string, cache: string] {
	const latency =
		score.latency_available === false
			? tl("Latency score: N/A")
			: tl("Latency score: {score}", { score: pct(score.latency_score) });
	const tokens = tl("Tokens: {tokens}", {
		tokens: formatNumber(score.total_tokens, locale),
	});
	const cost =
		typeof score.cost_micro_usd === "number"
			? tl("Cost: {cost}", {
					cost: formatMicroUsd(score.cost_micro_usd, "USD", 4, locale),
				})
			: tl("Cost: unknown");
	const cache = score.cache_hit ? tl("Cache: hit") : tl("Cache: miss");
	return [latency, tokens, cost, cache];
}
