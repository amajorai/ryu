import { describe, expect, test } from "bun:test";
import {
	DEFAULT_STATS_PLUGIN_ENABLED,
	deriveSessionStats,
	resolveContextFallback,
	type StatsMessage,
} from "./stats-model.ts";

const NOW = 1_700_000_000_000;

test("keeps app-owned Stats disabled unless the host opts in", () => {
	expect(DEFAULT_STATS_PLUGIN_ENABLED).toBe(false);
});

function assistant(parts: readonly unknown[]): StatsMessage {
	return { parts, role: "assistant" };
}

function user(): StatsMessage {
	return { parts: [{ text: "prompt", type: "text" }], role: "user" };
}

function ryuStats<Data extends object>(data: Data) {
	return { data, type: "data-ryu-stats" };
}

describe("deriveSessionStats", () => {
	test("rolls up turns, steps, transcript tokens, cache, speed, and cost", () => {
		const messages: StatsMessage[] = [
			user(),
			assistant([
				{ toolCallId: "tool-1", type: "tool-call" },
				{ output: "done", toolCallId: "tool-1", type: "tool-result" },
				ryuStats({
					cacheWriteTokens: 20,
					cachedTokens: 80,
					completionTokens: 40,
					cost: { amount: 0.01, currency: "EUR" },
					durationMs: 2000,
					observedAt: NOW - 10_000,
					promptPerSecond: 100,
					promptTokens: 100,
					tokensPerSecond: 20,
					totalTokens: 140,
				}),
			]),
			user(),
			assistant([
				{
					details: { ryuSteps: [{ name: "a" }, { name: "b" }] },
					type: "tool-step",
				},
				ryuStats({
					cacheWriteTokens: 10,
					cachedTokens: 30,
					completionTokens: 60,
					durationMs: 3000,
					observedAt: NOW - 1000,
					promptTokens: 200,
					totalTokens: 260,
				}),
			]),
		];

		const stats = deriveSessionStats(messages, {
			now: NOW,
			isMainChainActive: false,
		});
		expect(stats.turns).toBe(2);
		expect(stats.steps).toBe(3);
		expect(stats.inputTokens).toBe(300);
		expect(stats.outputTokens).toBe(100);
		expect(stats.cacheRead).toBe(30);
		expect(stats.cacheWrite).toBe(10);
		expect(stats.cacheHitRate).toBeCloseTo(0.75);
		expect(stats.totalTokens).toBe(400);
		expect(stats.inputSpeed).toBeCloseTo(100);
		expect(stats.outputSpeed).toBeCloseTo(20);
		expect(stats.costAmount).toBeCloseTo(0.01);
		expect(stats.costCurrency).toBe("EUR");
	});

	test("can switch cache metrics to cumulative session totals", () => {
		const stats = deriveSessionStats(
			[
				user(),
				assistant([
					ryuStats({
						cachedTokens: 80,
						completionTokens: 1,
						promptTokens: 100,
					}),
				]),
				user(),
				assistant([
					ryuStats({ cachedTokens: 20, completionTokens: 1, promptTokens: 50 }),
				]),
			],
			{ preferences: { cacheScope: "session" } }
		);
		expect(stats.cacheRead).toBe(100);
		expect(stats.cacheHitRate).toBe(1);
	});

	test("uses context-window transcript totals as input fallback and model hints for the window", () => {
		const stats = deriveSessionStats(
			[
				user(),
				assistant([
					ryuStats({
						context_window: {
							current_usage: { used: 500 },
							total_input_tokens: 321,
							total_output_tokens: 79,
						},
					}),
				]),
			],
			{ modelName: "claude-code-[1m]", now: NOW }
		);
		expect(stats.inputTokens).toBe(321);
		expect(stats.outputTokens).toBe(79);
		expect(stats.contextLength).toBe(500);
		expect(stats.contextWindow).toBe(1_000_000);
		expect(stats.contextPercent).toBeCloseTo(0.05);
	});

	test("counts compaction triggers, reclaimed tokens, and uses postTokens after a boundary", () => {
		const stats = deriveSessionStats(
			[
				user(),
				assistant([
					{
						data: { postTokens: 250, preTokens: 1000, trigger: "auto" },
						type: "compact_boundary",
					},
				]),
			],
			{ now: NOW }
		);
		expect(stats.compactions).toEqual({
			auto: 1,
			count: 1,
			manual: 0,
			reclaimedTokens: 750,
			unknown: 0,
		});
		expect(stats.contextLength).toBe(250);
	});

	test("cache timer is HOT for an active turn and becomes COLD after the TTL", () => {
		const messages = [
			user(),
			assistant([
				ryuStats({
					cachedTokens: 10,
					completionTokens: 1,
					observedAt: NOW - 6 * 60_000,
					promptTokens: 20,
				}),
			]),
		];
		expect(
			deriveSessionStats(messages, { isMainChainActive: true, now: NOW })
				.cacheTimer?.state
		).toBe("hot");
		expect(
			deriveSessionStats(messages, { isMainChainActive: false, now: NOW })
				.cacheTimer?.state
		).toBe("cold");
	});

	test("returns the configured context fallback only as a last resort", () => {
		expect(resolveContextFallback(123_456)).toBe(123_456);
		expect(resolveContextFallback(0)).toBe(200_000);
	});
});

test("keeps independent legacy numeric aliases and ignores unrelated native metadata", () => {
	const data = Object.create({
		inputTokens: "invalid",
		promptTokens: "0x10",
		outputTokens: Number.NaN,
		completionTokens: "2e1",
		cacheReadTokens: " ",
		cachedTokens: "4",
		durationMs: "1000",
	});
	Object.defineProperty(data, "opaqueMetadata", {
		get() {
			throw new Error("Statistics must not inspect unrelated metadata");
		},
	});
	const stats = deriveSessionStats([assistant([ryuStats(data)])], { now: NOW });
	expect(stats.inputTokens).toBe(16);
	expect(stats.outputTokens).toBe(20);
	expect(stats.totalTokens).toBe(36);
	expect(stats.cacheRead).toBe(4);
	expect(stats.outputSpeed).toBe(20);
});

test("retains native class carriers and the original part kind read ordering", () => {
	const nativeData = Object.assign(new Map([["native", "metadata"]]), {
		promptTokens: "7",
		completionTokens: "3",
	});
	let reads = 0;
	const part = {
		get type() {
			reads += 1;
			return "data-ryu-stats";
		},
		data: nativeData,
	};
	const stats = deriveSessionStats([assistant([part])], { now: NOW });
	expect(stats.inputTokens).toBe(7);
	expect(stats.outputTokens).toBe(3);
	expect(stats.totalTokens).toBe(10);
	expect(nativeData.get("native")).toBe("metadata");
	expect(reads).toBe(14);
});
