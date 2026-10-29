import { describe, expect, test } from "bun:test";
import type { DataUIPart, UIDataTypes, UIMessage } from "ai";
import {
	CONTEXT_CRITICAL_PCT,
	CONTEXT_WARN_PCT,
	contextRingColor,
	deriveContextUsage,
} from "./context-usage.tsx";

function assistantMessage(
	type: DataUIPart<UIDataTypes>["type"],
	data: DataUIPart<UIDataTypes>["data"]
): UIMessage {
	return {
		id: "assistant-1",
		role: "assistant",
		parts: [{ type, data }],
	};
}

describe("contextRingColor", () => {
	test("keeps usage below the warning threshold muted", () => {
		expect(contextRingColor(CONTEXT_WARN_PCT - 0.01)).toBe(
			"text-muted-foreground"
		);
	});

	test("uses the semantic warning token at the warning threshold", () => {
		expect(contextRingColor(CONTEXT_WARN_PCT)).toBe("text-status-warning");
	});

	test("keeps the semantic warning token before the critical threshold", () => {
		expect(
			contextRingColor((CONTEXT_WARN_PCT + CONTEXT_CRITICAL_PCT) / 2)
		).toBe("text-status-warning");
	});

	test("switches to the semantic destructive token at critical usage", () => {
		expect(contextRingColor(CONTEXT_CRITICAL_PCT)).toBe("text-status-destructive");
	});

	test("keeps over-limit usage destructive", () => {
		expect(contextRingColor(125)).toBe("text-status-destructive");
	});
});

describe("deriveContextUsage", () => {
	test("keeps ACP cache reads, writes, and its reported context window", () => {
		const usage = deriveContextUsage(
			[
				assistantMessage("data-acp-usage", {
					used: 1200,
					contextWindow: 32_000,
					promptTokens: 1680,
					completionTokens: 50,
					cachedReadTokens: 700,
					cachedWriteTokens: 80,
				}),
			],
			64_000
		);

		expect(usage).toMatchObject({
			used: 1200,
			total: 32_000,
			cacheReadTokens: 700,
			cachedTokens: 700,
			cacheWriteTokens: 80,
			cacheMissTokens: 900,
		});
	});

	test("does not derive misses when a cache subtotal is unavailable", () => {
		const usage = deriveContextUsage([
			assistantMessage("data-acp-usage", {
				used: 1200,
				promptTokens: 1680,
				completionTokens: 50,
				cachedReadTokens: 700,
			}),
		]);

		expect(usage?.cacheMissTokens).toBeUndefined();
	});

	test("derives misses only when local provider cache details are present", () => {
		const usage = deriveContextUsage(
			[
				assistantMessage("data-ryu-stats", {
					promptTokens: 1000,
					completionTokens: 100,
					cachedTokens: 700,
					cacheWriteTokens: 100,
					cacheMissTokens: 200,
					totalTokens: 1100,
				}),
			],
			16_000
		);

		expect(usage).toMatchObject({
			total: 16_000,
			used: 1100,
			cacheReadTokens: 700,
			cacheWriteTokens: 100,
			cacheMissTokens: 200,
		});
	});

	test("prefers provider-reported context occupancy and window", () => {
		const usage = deriveContextUsage(
			[
				assistantMessage("data-ryu-stats", {
					currentUsage: 4200,
					contextWindow: 32_000,
					totalTokens: 1100,
					completionTokens: 100,
				}),
			],
			64_000
		);

		expect(usage).toMatchObject({ used: 4200, total: 32_000 });
	});
});
