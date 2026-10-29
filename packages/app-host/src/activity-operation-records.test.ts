import { expect, test } from "bun:test";
import {
	type ActivityScoreResponse,
	activityAuditResponseSchema,
	activityEvalResponseSchema,
	activityPruneResponseSchema,
	activityRedteamResponseSchema,
	activityScoreResponseSchema,
	activityTraceResponseSchema,
} from "./activity-operation-records.ts";

test("audit replies retain complete rows, nullable attribution, and future metadata", () => {
	const row = {
		agent_id: null,
		api_key: "***",
		backend: null,
		command: null,
		cost_micro_usd: null,
		duration_ms: null,
		error: null,
		eval_score: null,
		event_type: "future_event",
		feature: null,
		id: "audit",
		input_tokens: null,
		latency_ms: null,
		model: null,
		output_tokens: null,
		prompt_cache_outcome: null,
		prompt_cache_read_tokens: null,
		prompt_cache_write_tokens: null,
		provider: null,
		request_id: "request",
		session_id: null,
		source: "future_source",
		timestamp: "2026-10-06T00:00:00Z",
		user_id: null,
		user_name: null,
		future: { measures: [1, 2] },
	};
	const reply = { count: 1, entries: [row], reachable: true };
	expect(activityAuditResponseSchema.parse(reply)).toBe(reply);
	expect(activityAuditResponseSchema.parse(reply).entries[0]).toBe(row);
	expect(
		activityAuditResponseSchema.safeParse({ entries: [], reachable: false })
			.success
	).toBe(false);
	expect(
		activityAuditResponseSchema.safeParse({
			...reply,
			entries: [{ ...row, id: 1 }],
		}).success
	).toBe(false);
});

test("trace replies retain complete normalized spans and unrecognized span kinds", () => {
	const span = {
		argsHash: null,
		conversationId: "conversation",
		endedAt: null,
		error: null,
		id: "span",
		kind: "future_span",
		name: "operation",
		seq: 1,
		sessionId: null,
		startedAt: 1,
	};
	const reply = { spans: [span] };
	expect(activityTraceResponseSchema.parse(reply)).toBe(reply);
	expect(activityTraceResponseSchema.parse(reply).spans[0]).toBe(span);
	expect(
		activityTraceResponseSchema.safeParse({ spans: [{ id: "incomplete" }] })
			.success
	).toBe(false);
});

test("retention replies retain optional server fields and validate values when supplied", () => {
	const reply = {
		deleted_rows: 3,
		kind: "future_retention_policy",
		max_rows: null,
		retention_days: null,
	};
	expect(activityPruneResponseSchema.parse(reply)).toBe(reply);
	expect(activityPruneResponseSchema.parse({})).toEqual({});
	expect(
		activityPruneResponseSchema.safeParse({ deleted_rows: "3" }).success
	).toBe(false);
});

const score = {
	assertion_score: 1,
	assertions: [{ detail: "Matched", kind: "contains", pass: true, score: 1 }],
	assertions_pass: true,
	context: { future: ["reference"] },
	cost_micro_usd: null,
	evaluators: [
		{
			category: "quality",
			detail: "Passed",
			executed: true,
			id: "quality",
			pass: true,
			score: 1,
		},
	],
	latency_score: 1,
	metadata: { future: true },
	overall: 1,
	policy_pass: true,
	prompt: "Complete this task",
	response_text: "Completed",
	substring_match: null,
	token_efficiency: 1,
	vars: { name: "User" },
};
const aggregate = {
	evaluators: {
		["__proto__"]: { executedCount: 1, meanScore: 1, passRate: 1 },
	},
	mean_latency: 1,
	mean_overall: 1,
	mean_substring_match: null,
	mean_token_efficiency: 1,
	policy_pass_rate: 1,
	total_cases: 1,
};

test("evaluation replies preserve full multi-model scores and evaluator map entries", () => {
	const reply = {
		aggregate,
		cases: [score],
		models: [{ aggregate, cases: [score], model: "future_model" }],
		tags: { ["__proto__"]: "retained" },
	};
	expect(activityEvalResponseSchema.parse(reply)).toBe(reply);
	expect(activityEvalResponseSchema.parse(reply).cases[0]).toBe(score);
	expect(activityEvalResponseSchema.parse(reply).models?.[0]?.aggregate).toBe(
		aggregate
	);
	expect(
		activityEvalResponseSchema.safeParse({
			...reply,
			tags: { ["__proto__"]: 42 },
		}).success
	).toBe(false);
	expect(
		activityEvalResponseSchema.safeParse({
			...reply,
			aggregate: { ...aggregate, evaluators: { ["__proto__"]: 42 } },
		}).success
	).toBe(false);
});

test("online scores validate their complete score and timestamp", () => {
	const reply = {
		kind: "online_score",
		score,
		scored_at: "2026-10-06T00:00:00Z",
	} satisfies ActivityScoreResponse;
	expect(activityScoreResponseSchema.parse(reply)).toBe(reply);
	expect(
		activityScoreResponseSchema.safeParse({ kind: "online_score", score })
			.success
	).toBe(false);
});

test("red-team replies preserve complete strategy results and nested evaluations", () => {
	const reply = {
		campaign_id: "campaign",
		model: "model",
		result: { aggregate, cases: [score] },
		strategies: [
			{
				detail: "Protected",
				evaluator: "security",
				id: "probe",
				name: "Probe",
				protected: true,
			},
		],
		summary: { needs_attention: 0, protected: 1, total: 1 },
	};
	expect(activityRedteamResponseSchema.parse(reply)).toBe(reply);
	expect(
		activityRedteamResponseSchema.safeParse({
			...reply,
			strategies: [{ id: "incomplete" }],
		}).success
	).toBe(false);
});
