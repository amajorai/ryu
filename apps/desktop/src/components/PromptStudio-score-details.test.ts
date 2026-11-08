import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import { scoreDetailLines } from "./PromptStudio-score-details.ts";

const JA: Record<string, string> = {
	"Cache: hit": "キャッシュ: ヒット",
	"Cache: miss": "キャッシュ: ミス",
	"Cost: unknown": "コスト: 不明",
	"Cost: {cost}": "コスト: {cost}",
	"Latency score: N/A": "レイテンシスコア: 該当なし",
	"Latency score: {score}": "レイテンシスコア: {score}",
	"Tokens: {tokens}": "トークン: {tokens}",
};

const ja: LiteralMessage = (source, values) =>
	formatMessage(JA[source] ?? source, values);

const BASE = {
	latency_score: 0.5,
	total_tokens: 12_345,
};

describe("scoreDetailLines", () => {
	test("a cache hit with no cost reads as whole Japanese messages", () => {
		const lines = scoreDetailLines(
			{ ...BASE, cache_hit: true, cost_micro_usd: null },
			ja,
			"ja"
		);
		expect(lines[2]).toBe("コスト: 不明");
		expect(lines[3]).toBe("キャッシュ: ヒット");
		expect(lines[1]).toBe("トークン: 12,345");
		for (const line of lines) {
			expect(line).not.toMatch(/unknown|hit|miss|N\/A|µUSD/);
		}
	});

	test("unavailable latency, a miss and a known cost", () => {
		const [latency, tokens, cost, cache] = scoreDetailLines(
			{
				...BASE,
				cache_hit: false,
				cost_micro_usd: 1_500_000,
				latency_available: false,
				total_tokens: undefined,
			},
			ja,
			"ja"
		);
		expect(latency).toBe("レイテンシスコア: 該当なし");
		expect(tokens).toBe("トークン: —");
		expect(cost.startsWith("コスト: ")).toBe(true);
		expect(cost).toContain("1.50");
		expect(cache).toBe("キャッシュ: ミス");
	});
});
