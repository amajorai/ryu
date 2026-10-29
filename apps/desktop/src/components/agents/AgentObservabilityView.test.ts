import { describe, expect, test } from "bun:test";
import type { AuditEntry } from "@/src/lib/api/gateway.ts";
import {
	filterAuditEntries,
	promptCacheStatus,
	summarizeAudit,
} from "./AgentObservabilityView.tsx";

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
	return {
		agent_id: "agent-1",
		api_key: "***",
		backend: null,
		command: null,
		cost_micro_usd: 1250,
		cache_read_tokens: null,
		cache_write_tokens: null,
		duration_ms: null,
		error: null,
		eval_score: 0.8,
		event_type: "model_call",
		feature: "chat",
		id: "audit-1",
		input_tokens: 100,
		latency_ms: 500,
		model: "gpt-4o-mini",
		output_tokens: 50,
		prompt_cache_outcome: null,
		prompt_cache_read_tokens: null,
		prompt_cache_write_tokens: null,
		provider: "openai",
		request_id: "req-1",
		session_id: "run-1",
		timestamp: "2026-09-10T00:00:00Z",
		user_id: null,
		user_name: null,
		...overrides,
	};
}

describe("agent observability aggregates", () => {
	test("summarizes latency, tokens, cost, errors, and quality", () => {
		const summary = summarizeAudit([
			entry(),
			entry({
				cost_micro_usd: null,
				error: "timeout",
				eval_score: null,
				id: "audit-2",
				input_tokens: 25,
				latency_ms: 1500,
				output_tokens: 10,
			}),
		]);

		expect(summary).toEqual({
			averageLatencyMs: 1000,
			promptCacheHitRate: null,
			promptCacheHitRequests: 0,
			promptCacheMissRequests: 0,
			promptCacheReadTokens: null,
			promptCacheWriteTokens: null,
			costMicroUsd: 1250,
			errorCount: 1,
			qualityScore: 0.8,
			totalInputTokens: 125,
			totalOutputTokens: 60,
			totalCacheReadTokens: null,
			totalCacheWriteTokens: null,
			totalCacheMissTokens: null,
			totalRequests: 2,
		});
	});

	test("summarizes reported prompt cache hits, misses, reads, and writes", () => {
		const summary = summarizeAudit([
			entry({
				prompt_cache_outcome: "injected",
				prompt_cache_read_tokens: 800,
				prompt_cache_write_tokens: 200,
			}),
			entry({
				id: "audit-2",
				prompt_cache_outcome: "injected",
				prompt_cache_read_tokens: 0,
				prompt_cache_write_tokens: 500,
			}),
			entry({
				id: "audit-3",
				prompt_cache_outcome: "disabled",
				prompt_cache_read_tokens: 0,
				prompt_cache_write_tokens: 0,
			}),
		]);

		expect(summary).toMatchObject({
			promptCacheHitRate: 800 / 1500,
			promptCacheHitRequests: 1,
			promptCacheMissRequests: 1,
			promptCacheReadTokens: 800,
			promptCacheWriteTokens: 700,
		});
	});

	test("labels reads and cold writes without treating unreported usage as a miss", () => {
		expect(
			promptCacheStatus(
				entry({
					prompt_cache_outcome: "injected",
					prompt_cache_read_tokens: 1200,
					prompt_cache_write_tokens: 0,
				})
			)
		).toBe("Hit");
		expect(
			promptCacheStatus(
				entry({
					prompt_cache_outcome: "injected",
					prompt_cache_read_tokens: 0,
					prompt_cache_write_tokens: 100,
				})
			)
		).toBe("Miss + write");
		expect(promptCacheStatus(entry())).toBeNull();
	});

	test("reports OpenRouter cache hits, writes, and uncached prompt tokens", () => {
		const summary = summarizeAudit([
			entry({
				cache_read_tokens: 800,
				cache_write_tokens: 100,
				input_tokens: 1000,
				provider: "openrouter",
			}),
			entry({
				cache_read_tokens: 0,
				cache_write_tokens: 0,
				input_tokens: 250,
				provider: "openrouter",
			}),
		]);

		expect(summary.totalCacheReadTokens).toBe(800);
		expect(summary.totalCacheWriteTokens).toBe(100);
		expect(summary.totalCacheMissTokens).toBe(350);
	});

	test("filters errors, slow calls, event kind, and search terms", () => {
		const values = [
			entry(),
			entry({
				event_type: "exec_call",
				id: "audit-2",
				latency_ms: 1500,
				model: null,
				provider: null,
				command: "write_file",
			}),
			entry({
				error: "provider timeout",
				id: "audit-3",
				latency_ms: 2000,
			}),
		];

		expect(
			filterAuditEntries(values, "", "errors").map((item) => item.id)
		).toEqual(["audit-3"]);
		expect(
			filterAuditEntries(values, "", "slow").map((item) => item.id)
		).toEqual(["audit-2", "audit-3"]);
		expect(
			filterAuditEntries(values, "write_file", "all").map((item) => item.id)
		).toEqual(["audit-2"]);
		expect(
			filterAuditEntries(values, "", "tool").map((item) => item.id)
		).toEqual(["audit-2"]);
	});
});
