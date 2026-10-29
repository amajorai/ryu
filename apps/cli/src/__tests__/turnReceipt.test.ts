// Unit tests for the turn receipt and session meter formatters
// (core/turnReceipt.ts): unknown values are omitted, never printed as zero.

import { expect, test } from "bun:test";
import {
	formatCost,
	formatDuration,
	formatSessionMeter,
	formatTokenCount,
	formatTurnReceipt,
	mergeUsage,
	summarizeSessionUsage,
	turnReceiptParts,
} from "../core/turnReceipt.ts";

test("formats token counts compactly", () => {
	expect(formatTokenCount(950)).toBe("950");
	expect(formatTokenCount(1234)).toBe("1.2K");
	expect(formatTokenCount(12_300)).toBe("12.3K");
	expect(formatTokenCount(2000)).toBe("2K");
	expect(formatTokenCount(999_999)).toBe("1M");
	expect(formatTokenCount(2_500_000)).toBe("2.5M");
});

test("formats durations and costs", () => {
	expect(formatDuration(12_400)).toBe("12.4s");
	expect(formatDuration(800)).toBe("0.8s");
	expect(formatDuration(65_000)).toBe("1m 5s");
	expect(formatDuration(120_000)).toBe("2m");
	expect(formatCost(0.42)).toBe("$0.42");
	expect(formatCost(0.0042, "usd")).toBe("$0.0042");
	expect(formatCost(1.5, "EUR")).toBe("1.50 EUR");
});

test("a full receipt names agent, model, time, tokens, and speed", () => {
	expect(
		formatTurnReceipt({
			agentLabel: "coder",
			modelLabel: "claude-sonnet",
			elapsedMs: 99_000,
			usage: {
				source: "ryu-stats",
				durationMs: 12_400,
				totalTokens: 1200,
				tokensPerSecond: 38.4,
			},
		})
	).toBe("coder · claude-sonnet · 12.4s · 1.2K tok · 38 tok/s");
});

test("a receipt omits every segment it does not know", () => {
	expect(formatTurnReceipt({ elapsedMs: 3200 })).toBe("3.2s");
	expect(formatTurnReceipt({ agentLabel: "coder", modelLabel: null })).toBe(
		"coder"
	);
	expect(
		formatTurnReceipt({
			usage: { source: "acp-usage", outputTokens: 0, tokensPerSecond: 0 },
		})
	).toBe("");
	expect(
		formatTurnReceipt({
			usage: { source: "acp-usage", inputTokens: 500, outputTokens: 700 },
		})
	).toBe("1.2K tok");
});

test("usage snapshots replace field by field instead of adding up", () => {
	const first = mergeUsage(undefined, {
		source: "acp-usage",
		contextUsed: 100,
		costAmount: 0.1,
	});
	expect(mergeUsage(first, { source: "acp-usage", contextUsed: 200 })).toEqual({
		source: "acp-usage",
		contextUsed: 200,
		costAmount: 0.1,
	});
});

test("the session meter shows context % only with a context window", () => {
	expect(
		formatSessionMeter(
			summarizeSessionUsage([
				{
					source: "acp-usage",
					contextUsed: 9000,
					contextTotal: 153_750,
					costAmount: 0.2,
				},
				undefined,
				{
					source: "acp-usage",
					contextUsed: 12_300,
					contextTotal: 153_750,
					costAmount: 0.42,
				},
			])
		)
	).toBe("12.3K (8%) · $0.42");
	expect(
		formatSessionMeter(
			summarizeSessionUsage([
				{ source: "ryu-stats", totalTokens: 700, costAmount: 0.01 },
				{ source: "ryu-stats", totalTokens: 800 },
			])
		)
	).toBe("1.5K · $0.01");
	expect(formatSessionMeter(summarizeSessionUsage([undefined]))).toBe("");
});

test("splits the receipt into truncatable names and whole numbers", () => {
	expect(
		turnReceiptParts({
			agentLabel: "coder",
			modelLabel: "claude-sonnet-4",
			elapsedMs: 4200,
			usage: { source: "ryu-usage", totalTokens: 1200, tokensPerSecond: 38.2 },
		})
	).toEqual({
		identity: "coder · claude-sonnet-4",
		stats: "4.2s · 1.2K tok · 38 tok/s",
	});
	expect(turnReceiptParts({})).toEqual({ identity: "", stats: "" });
});

test("a Core usage meter's session cost is a snapshot, not a per-turn sum", () => {
	expect(
		formatSessionMeter(
			summarizeSessionUsage([
				{ source: "ryu-usage", contextUsed: 9000, costAmount: 0.2 },
				{ source: "ryu-usage", contextUsed: 12_300, costAmount: 0.42 },
			])
		)
	).toBe("12.3K · $0.42");
});
