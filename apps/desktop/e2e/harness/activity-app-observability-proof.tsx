import { createRoot } from "react-dom/client";
import { Activity } from "../../../../apps-store/activity/ui/src/Activity.tsx";
import type { RyuBridge } from "../../../../apps-store/activity/ui/src/ryu.d.ts";
import type { ActivityItem } from "../../../../apps-store/activity/ui/src/types.ts";
import styles from "./activity-app-observability-proof.module.css";
import "../../../../apps-store/activity/ui/src/tailwind.css";

const AGENT_ID = "observability-proof-agent";
const RUN_ID = "run-proof-success";
const PROOF_NOW = Date.now();

const ACTIVITY: ActivityItem[] = [
	{
		agent_id: AGENT_ID,
		body: "A completed agent run is ready to inspect.",
		created_at: Math.floor(PROOF_NOW / 1000) - 120,
		id: "activity-proof-run",
		kind: "run_completed",
		level: "success",
		metadata: {},
		session_id: RUN_ID,
		source: "runs",
		title: "Agent run completed",
	},
	{
		agent_id: null,
		body: "All monitored services have checked in.",
		created_at: Math.floor(PROOF_NOW / 1000) - 60,
		id: "activity-proof-note",
		kind: "heartbeat",
		level: "info",
		metadata: {},
		session_id: null,
		source: "monitors",
		title: "Monitor heartbeat recovered",
	},
];

const AUDIT = {
	count: 3,
	entries: [
		{
			agent_id: AGENT_ID,
			api_key: null,
			backend: null,
			duration_ms: null,
			prompt_cache_outcome: null,
			prompt_cache_read_tokens: null,
			prompt_cache_write_tokens: null,
			user_id: null,
			user_name: null,
			command: null,
			cost_micro_usd: 2400,
			error: null,
			eval_score: 0.92,
			event_type: "model_call",
			feature: "chat",
			id: "audit-proof-success",
			input_tokens: 420,
			latency_ms: 640,
			model: "gpt-4o-mini",
			output_tokens: 180,
			provider: "openai",
			request_id: "req-proof-success",
			session_id: RUN_ID,
			timestamp: new Date(PROOF_NOW - 15 * 60 * 1000).toISOString(),
		},
		{
			agent_id: AGENT_ID,
			api_key: null,
			backend: null,
			duration_ms: null,
			prompt_cache_outcome: null,
			prompt_cache_read_tokens: null,
			prompt_cache_write_tokens: null,
			user_id: null,
			user_name: null,
			command: null,
			cost_micro_usd: 1100,
			error: "provider timeout",
			eval_score: null,
			event_type: "model_call",
			feature: "chat",
			id: "audit-proof-error",
			input_tokens: 260,
			latency_ms: 1840,
			model: "claude-3-5-sonnet",
			output_tokens: 0,
			provider: "anthropic",
			request_id: "req-proof-error",
			session_id: "run-proof-error",
			timestamp: new Date(PROOF_NOW - 2 * 60 * 60 * 1000).toISOString(),
		},
		{
			agent_id: AGENT_ID,
			api_key: null,
			backend: null,
			duration_ms: null,
			prompt_cache_outcome: null,
			prompt_cache_read_tokens: null,
			prompt_cache_write_tokens: null,
			user_id: null,
			user_name: null,
			command: "search_docs",
			cost_micro_usd: 0,
			error: null,
			eval_score: null,
			event_type: "exec_call",
			feature: "tools",
			id: "audit-proof-tool",
			input_tokens: 0,
			latency_ms: 1180,
			model: null,
			output_tokens: 0,
			provider: null,
			request_id: "req-proof-tool",
			session_id: null,
			timestamp: new Date(PROOF_NOW - 30 * 60 * 1000).toISOString(),
		},
	],
	reachable: true,
};

type ActivityProofPayload =
	| Parameters<RyuBridge["activity"][keyof RyuBridge["activity"]]>[0]
	| Parameters<RyuBridge["shell"]["openTab"]>[0];

type ActivityProofOperation =
	| "audit"
	| "eval"
	| "importTrace"
	| "list"
	| "openTab"
	| "prune"
	| "redteam"
	| "score"
	| "trace";

interface ActivityProofCall {
	operation: ActivityProofOperation;
	payload?: ActivityProofPayload;
}

declare global {
	interface Window {
		__activityProof: {
			calls: () => ActivityProofCall[];
			failNext: (operation: ActivityProofOperation) => void;
		};
	}
}

const activityProofCalls: ActivityProofCall[] = [];
const failNextOperations = new Set<ActivityProofOperation>();
let currentAuditEntries = [...AUDIT.entries];

if (new URLSearchParams(window.location.search).get("failListOnce") === "1") {
	failNextOperations.add("list");
}

if (new URLSearchParams(window.location.search).get("failListOnce") === "1") {
	failNextOperations.add("list");
}

function captureActivityCall(
	operation: ActivityProofOperation,
	payload?: ActivityProofPayload
) {
	activityProofCalls.push({ operation, payload });
	if (failNextOperations.delete(operation)) {
		throw new Error(`${operation} failed for proof`);
	}
}

window.__activityProof = {
	calls: () => structuredClone(activityProofCalls),
	failNext: (operation) => failNextOperations.add(operation),
};

const bridge: RyuBridge = {
	activity: {
		audit: async (input) => {
			captureActivityCall("audit", input);
			const from = input?.from
				? new Date(input.from).getTime()
				: Number.NEGATIVE_INFINITY;
			const entries = currentAuditEntries
				.filter((entry) => new Date(entry.timestamp).getTime() >= from)
				.slice(0, input?.limit ?? 100);
			return { ...AUDIT, count: entries.length, entries };
		},
		prune: async () => {
			captureActivityCall("prune");
			const previousCount = currentAuditEntries.length;
			currentAuditEntries = currentAuditEntries.filter((entry) => !entry.error);
			return { deleted_rows: previousCount - currentAuditEntries.length };
		},
		score: async (input) => {
			captureActivityCall("score", input);
			return {
				score: {
					assertion_score: 1,
					assertions: [],
					assertions_pass: true,
					latency_score: 1,
					overall: 0.91,
					policy_pass: true,
					prompt: input.prompt ?? "",
					response_text: "A grounded answer.",
					substring_match: null,
					token_efficiency: 1,
				},
				kind: "online_score",
				scored_at: new Date(PROOF_NOW).toISOString(),
			};
		},
		eval: async (input) => {
			captureActivityCall("eval", input);
			return {
				aggregate: {
					mean_latency: 0,
					mean_substring_match: null,
					mean_token_efficiency: 1,
					mean_overall: 0.88,
					policy_pass_rate: 1,
					total_cases: 3,
				},
				cases: [],
			};
		},
		importTrace: async (input) => {
			captureActivityCall("importTrace", input);
			return {
				added: true,
				case: {},
				source_run_id: input.run_id,
				suite: {
					agent_id: input.agent_id ?? AGENT_ID,
					config: {},
					created_at: PROOF_NOW,
					id: "suite-proof",
					name: "Agent regression suite",
					updated_at: PROOF_NOW,
				},
				version: null,
			};
		},
		list: async (input) => {
			captureActivityCall("list", input);
			return ACTIVITY;
		},
		redteam: async (input) => {
			captureActivityCall("redteam", input);
			return {
				campaign_id: "campaign-proof",
				model: "gpt-4o-mini",
				strategies: [
					"Prompt injection",
					"Jailbreak resistance",
					"PII exfiltration",
					"Tool misuse",
					"Toxic output",
				].map((name, index) => ({
					evaluator: "native-proof",
					detail: "Evaluator detected the unsafe behavior was blocked.",
					id: `strategy-proof-${index}`,
					name,
					protected: true,
				})),
				summary: { needs_attention: 0, protected: 5, total: 5 },
			};
		},
		trace: async (input) => {
			captureActivityCall("trace", input);
			return {
				spans: [
					{
						args_hash: null,
						ended_at: 1_789_334_760_640,
						error: null,
						id: "span-proof-model",
						kind: "model-call",
						name: "gpt-4o-mini",
						started_at: 1_789_334_760_000,
					},
					{
						args_hash: "4edc3c76f9b1",
						ended_at: 1_789_334_761_180,
						error: null,
						id: "span-proof-tool",
						kind: "tool-call",
						name: "search_docs",
						started_at: 1_789_334_760_640,
					},
				],
			};
		},
	},
	context: null,
	shell: {
		openTab: async (input) => {
			captureActivityCall("openTab", input);
			const { conversationId } = input;
			document.body.dataset.openedRun = conversationId ?? "";
		},
		subscribeTheme: () => ({ dispose: () => undefined }),
		subscribeEvents: () => ({ dispose: () => undefined }),
	},
};

window.ryu = bridge;

function Proof() {
	return (
		<main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
			<div className="mx-auto max-w-6xl">
				<div
					className={`${styles.status} mb-6 rounded-full border px-3 py-1.5 font-semibold text-xs`}
					data-testid="activity-proof-status"
				>
					Activity Companion mounted
				</div>
				<Activity />
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Activity proof root is missing");
}
createRoot(root).render(<Proof />);
