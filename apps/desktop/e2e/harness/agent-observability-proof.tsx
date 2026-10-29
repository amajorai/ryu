import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { AgentObservabilityView } from "../../src/components/agents/AgentObservabilityView.tsx";
import type { AuditEntry } from "../../src/lib/api/gateway.ts";
import type { ProofJsonRecord } from "../fixture-json.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const TARGET = { token: null, url: "http://127.0.0.1:8780" };
const AGENT_ID = "observability-proof-agent";
const API_STORE_KEY = "agent-observability-proof-api-store";
const PROOF_TIME = Date.parse("2026-09-28T12:00:00.000Z");

interface PromptSuiteWire {
	agent_id: string;
	config: ProofJsonRecord;
	created_at: number;
	id: string;
	name: string;
	updated_at: number;
}

interface ProofApiStore {
	auditEntries: AuditEntry[];
	importedRunIds: string[];
	prunedRows: number;
	suites: PromptSuiteWire[];
}

interface ProofRequest {
	body: unknown;
	method: string;
	path: string;
	query: Record<string, string>;
	status: number;
}

type FailurePoint =
	| "audit"
	| "prune"
	| "trace"
	| "suiteList"
	| "suiteCreate"
	| "traceImport"
	| "score"
	| "redteam";

interface ProofApiSnapshot {
	auditEntries: AuditEntry[];
	importedRunIds: string[];
	prunedRows: number;
	requests: ProofRequest[];
	suites: PromptSuiteWire[];
}

declare global {
	interface Window {
		__AGENT_OBSERVABILITY_PROOF__: {
			appendRefreshFixtureEntry: () => void;
			failNext: (point: FailurePoint) => void;
			snapshot: () => ProofApiSnapshot;
		};
	}
}

const SuiteInputSchema = z.object({
	agent_id: z.string(),
	config: z.record(z.string(), z.json()),
	name: z.string(),
});
const SuiteSchema = SuiteInputSchema.extend({
	created_at: z.number(),
	id: z.string(),
	updated_at: z.number(),
});
const AuditSchema = z.object({
	agent_id: z.string().nullable(),
	api_key: z.string().nullable(),
	backend: z.string().nullable(),
	command: z.string().nullable(),
	error: z.string().nullable(),
	event_type: z.string().nullable(),
	feature: z.string().nullable(),
	model: z.string().nullable(),
	prompt_cache_outcome: z.string().nullable(),
	provider: z.string().nullable(),
	session_id: z.string().nullable(),
	user_id: z.string().nullable(),
	user_name: z.string().nullable(),
	cost_micro_usd: z.number().nullable(),
	duration_ms: z.number().nullable(),
	eval_score: z.number().nullable(),
	input_tokens: z.number().nullable(),
	latency_ms: z.number().nullable(),
	output_tokens: z.number().nullable(),
	prompt_cache_read_tokens: z.number().nullable(),
	prompt_cache_write_tokens: z.number().nullable(),
	id: z.string(),
	request_id: z.string(),
	timestamp: z.string(),
	cache_read_tokens: z.number().nullish(),
	cache_write_tokens: z.number().nullish(),
	source: z
		.enum(["byok", "local", "managed", "self_hosted", "unknown"])
		.optional(),
	widget_instance_id: z.string().nullish(),
}) satisfies z.ZodType<AuditEntry>;
const StoreSchema = z.object({
	auditEntries: AuditSchema.array(),
	importedRunIds: z.string().array(),
	prunedRows: z.number(),
	suites: SuiteSchema.array(),
}) satisfies z.ZodType<ProofApiStore>;

const SUITE = {
	agent_id: AGENT_ID,
	config: { prompts: [], providers: ["gpt-4o-mini"], tests: [] },
	created_at: PROOF_TIME,
	id: "suite-observability-proof",
	name: "Agent regression suite",
	updated_at: PROOF_TIME,
};

const AUDIT_ENTRIES: AuditEntry[] = [
	{
		agent_id: AGENT_ID,
		api_key: "***",
		backend: "openai",
		command: null,
		cost_micro_usd: 24_000,
		duration_ms: null,
		error: null,
		eval_score: 0.92,
		event_type: "model_call",
		feature: "chat",
		id: "audit-proof-success",
		input_tokens: 42_000,
		cache_read_tokens: 700,
		cache_write_tokens: 80,
		latency_ms: 640,
		model: "openai/gpt-4o-mini",
		output_tokens: 180,
		prompt_cache_outcome: "injected",
		prompt_cache_read_tokens: 300,
		prompt_cache_write_tokens: 100,
		provider: "openrouter",
		request_id: "req-proof-success",
		session_id: "run-proof-success",
		timestamp: new Date(PROOF_TIME - 30 * 60_000).toISOString(),
		user_id: null,
		user_name: null,
	},
	{
		agent_id: AGENT_ID,
		api_key: "***",
		backend: "anthropic",
		command: null,
		cost_micro_usd: 1100,
		duration_ms: null,
		error: "provider timeout",
		eval_score: null,
		event_type: "model_call",
		feature: "chat",
		id: "audit-proof-error",
		input_tokens: 260,
		latency_ms: 1840,
		model: "claude-3-5-sonnet",
		output_tokens: 0,
		prompt_cache_outcome: "injected",
		prompt_cache_read_tokens: 0,
		prompt_cache_write_tokens: 100,
		provider: "anthropic",
		request_id: "req-proof-error",
		session_id: "run-proof-error",
		timestamp: new Date(PROOF_TIME - 3 * 24 * 60 * 60_000).toISOString(),
		user_id: null,
		user_name: null,
	},
	{
		agent_id: AGENT_ID,
		api_key: "***",
		backend: "local",
		command: "search_docs",
		cost_micro_usd: 0,
		duration_ms: null,
		error: null,
		eval_score: null,
		event_type: "exec_call",
		feature: "tool",
		id: "audit-proof-tool",
		input_tokens: null,
		latency_ms: 220,
		model: null,
		output_tokens: null,
		prompt_cache_outcome: null,
		prompt_cache_read_tokens: null,
		prompt_cache_write_tokens: null,
		provider: "local-agent",
		request_id: "req-proof-tool",
		session_id: null,
		timestamp: new Date(PROOF_TIME - 10 * 24 * 60 * 60_000).toISOString(),
		user_id: null,
		user_name: null,
	},
];

function jsonResponse<FixturePayload>(
	value: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(value), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

function readProofStore(): ProofApiStore {
	const value = localStorage.getItem(API_STORE_KEY);
	if (value) {
		try {
			return StoreSchema.parse(JSON.parse(value));
		} catch {
			// Invalid local proof state is reset to deterministic fixture data.
		}
	}
	const initial: ProofApiStore = {
		auditEntries: AUDIT_ENTRIES,
		importedRunIds: [],
		prunedRows: 0,
		suites: [],
	};
	localStorage.setItem(API_STORE_KEY, JSON.stringify(initial));
	return initial;
}

function persistProofStore(store: ProofApiStore): void {
	localStorage.setItem(API_STORE_KEY, JSON.stringify(store));
}

function parseRequestBody(body: BodyInit | null | undefined) {
	if (!isNativeText(body)) {
		return null;
	}
	try {
		return parseProofJson(body);
	} catch {
		return null;
	}
}

function makeRunTrace(runId: string) {
	if (runId !== "run-proof-success") {
		return { spans: [] };
	}
	return {
		spans: [
			{
				args_hash: null,
				conversation_id: runId,
				ended_at: PROOF_TIME - 19_660,
				error: null,
				id: "span-proof-model",
				kind: "model-call",
				name: "gpt-4o-mini",
				seq: 1,
				session_id: runId,
				started_at: PROOF_TIME - 20_300,
			},
			{
				args_hash: "4edc3c76f9b1",
				conversation_id: runId,
				ended_at: PROOF_TIME - 19_480,
				error: null,
				id: "span-proof-tool",
				kind: "tool-call",
				name: "search_docs",
				seq: 2,
				session_id: runId,
				started_at: PROOF_TIME - 19_660,
			},
		],
	};
}

function installProofApi(): void {
	const failures = new Map<FailurePoint, boolean>([
		["audit", false],
		["prune", false],
		["trace", false],
		["suiteList", false],
		["suiteCreate", false],
		["traceImport", false],
		["score", false],
		["redteam", false],
	]);
	const requests: ProofRequest[] = [];
	let store = readProofStore();
	const record = <Body,>(
		method: string,
		url: URL,
		body: Body,
		status: number
	): void => {
		requests.push({
			body,
			method,
			path: url.pathname,
			query: Object.fromEntries(url.searchParams.entries()),
			status,
		});
	};
	const fail = (point: FailurePoint): boolean => {
		if (!failures.get(point)) {
			return false;
		}
		failures.set(point, false);
		return true;
	};

	window.__AGENT_OBSERVABILITY_PROOF__ = {
		appendRefreshFixtureEntry: () => {
			const entry: AuditEntry = {
				...AUDIT_ENTRIES[0],
				cost_micro_usd: 500,
				feature: "background-refresh",
				id: "audit-proof-refreshed",
				model: "qwen2.5:7b",
				prompt_cache_read_tokens: null,
				prompt_cache_write_tokens: null,
				provider: "ollama",
				request_id: "req-proof-refreshed",
				session_id: "run-proof-refreshed",
				timestamp: new Date(PROOF_TIME - 5 * 60_000).toISOString(),
			};
			store = {
				...store,
				auditEntries: [entry, ...store.auditEntries],
			};
			persistProofStore(store);
		},
		failNext: (point) => {
			failures.set(point, true);
		},
		snapshot: () => structuredClone({ ...store, requests: requests.slice() }),
	};

	const nativeFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const request = input instanceof Request ? input : null;
		const url = new URL(request?.url ?? String(input), window.location.href);
		if (!url.pathname.startsWith("/api/")) {
			return nativeFetch(input, init);
		}
		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		const body = parseRequestBody(
			init?.body ?? (request ? await request.clone().text() : null)
		);
		const failedResponse = (point: FailurePoint) => {
			if (!fail(point)) {
				return null;
			}
			record(method, url, body, 503);
			return jsonResponse({ message: `${point}_fixture_unavailable` }, 503);
		};

		if (url.pathname === "/api/gateway/audit/prune" && method === "POST") {
			const failed = failedResponse("prune");
			if (failed) {
				return failed;
			}
			const deletedRows = store.auditEntries.length;
			store = {
				...store,
				auditEntries: [],
				prunedRows: store.prunedRows + deletedRows,
			};
			persistProofStore(store);
			record(method, url, body, 200);
			return jsonResponse({
				deleted_rows: deletedRows,
				kind: "pruned",
				max_rows: 1000,
				retention_days: 90,
			});
		}

		if (url.pathname === "/api/gateway/audit" && method === "GET") {
			const failed = failedResponse("audit");
			if (failed) {
				return failed;
			}
			const from = url.searchParams.get("from");
			const fromMs = from ? Date.parse(from) : Number.NEGATIVE_INFINITY;
			const limit = Number(url.searchParams.get("limit") ?? 100);
			const entries = store.auditEntries
				.filter((entry) => Date.parse(entry.timestamp) >= fromMs)
				.slice(0, limit);
			record(method, url, body, 200);
			return jsonResponse({ count: entries.length, entries, reachable: true });
		}

		// The production node-default model hook reads this specific persisted selection.
		if (
			url.pathname === "/api/preferences/default-local-agent-selection" &&
			method === "GET"
		) {
			record(method, url, body, 200);
			return jsonResponse({
				key: "default-local-agent-selection",
				value: JSON.stringify({
					agent_id: "",
					model: "gpt-4o-mini",
					provider: "openai",
					thinking_level: "",
					effort: "",
					access_mode: "",
				}),
			});
		}

		if (url.pathname === "/api/models/context-window" && method === "GET") {
			record(method, url, body, 200);
			return jsonResponse({ contextLength: 128_000 });
		}

		if (url.pathname === "/api/gateway/evals/score" && method === "POST") {
			const failed = failedResponse("score");
			if (failed) {
				return failed;
			}
			record(method, url, body, 200);
			return jsonResponse({
				kind: "online_score",
				score: {
					assertion_score: 1,
					assertions: [],
					assertions_pass: true,
					latency_score: 0.98,
					mean_overall: 0.91,
					overall: 0.91,
					policy_pass: true,
					prompt: "",
					response_text: "A grounded answer.",
					substring_match: null,
					token_efficiency: 0.84,
				},
				scored_at: new Date(PROOF_TIME).toISOString(),
			});
		}

		if (url.pathname === "/api/gateway/redteam/run" && method === "POST") {
			const failed = failedResponse("redteam");
			if (failed) {
				return failed;
			}
			record(method, url, body, 200);
			return jsonResponse({
				campaign_id: "rtc-proof",
				model: "gpt-4o-mini",
				strategies: [
					"Prompt injection",
					"Jailbreak resistance",
					"PII exfiltration",
					"Tool misuse",
					"Toxic output",
				].map((name, index) => ({
					detail: "Evaluator detected the unsafe behavior was blocked.",
					evaluator: index === 0 ? "prompt_injection" : "toxicity",
					id: `strategy-proof-${index}`,
					name,
					protected: true,
				})),
				summary: { needs_attention: 0, protected: 5, total: 5 },
			});
		}

		const tracePath = url.pathname.match(/^\/api\/runs\/([^/]+)\/trace$/);
		if (tracePath && method === "GET") {
			const failed = failedResponse("trace");
			if (failed) {
				return failed;
			}
			record(method, url, body, 200);
			return jsonResponse(makeRunTrace(decodeURIComponent(tracePath[1])));
		}

		if (url.pathname === "/api/prompt-suites" && method === "GET") {
			const failed = failedResponse("suiteList");
			if (failed) {
				return failed;
			}
			const agentId = url.searchParams.get("agent_id");
			const suites = store.suites.filter((suite) => suite.agent_id === agentId);
			record(method, url, body, 200);
			return jsonResponse({ suites });
		}

		if (url.pathname === "/api/prompt-suites" && method === "POST") {
			const failed = failedResponse("suiteCreate");
			if (failed) {
				return failed;
			}
			const input = SuiteInputSchema.parse(body);
			const suite: PromptSuiteWire = {
				agent_id: input.agent_id,
				config: input.config,
				created_at: PROOF_TIME,
				id: SUITE.id,
				name: input.name,
				updated_at: PROOF_TIME,
			};
			store = { ...store, suites: [...store.suites, suite] };
			persistProofStore(store);
			record(method, url, body, 200);
			return jsonResponse({
				suite,
				version: {
					created_at: PROOF_TIME,
					id: "version-suite-proof",
					label: "Trace baseline",
					suite_id: SUITE.id,
				},
			});
		}

		const importPath = url.pathname.match(
			/^\/api\/prompt-suites\/([^/]+)\/traces$/
		);
		if (importPath && method === "POST") {
			const failed = failedResponse("traceImport");
			if (failed) {
				return failed;
			}
			const runId = z.object({ run_id: z.string() }).parse(body).run_id;
			const suiteId = decodeURIComponent(importPath[1]);
			const suite = store.suites.find((candidate) => candidate.id === suiteId);
			if (!suite) {
				record(method, url, body, 404);
				return jsonResponse({ message: "suite_fixture_missing" }, 404);
			}
			const added = !store.importedRunIds.includes(runId);
			if (added) {
				store = {
					...store,
					importedRunIds: [...store.importedRunIds, runId],
				};
				persistProofStore(store);
			}
			record(method, url, body, 200);
			return jsonResponse({
				added,
				case: {
					id: `trace-${runId}`,
					metadata: { source: "ryu-trace" },
					prompt: "Explain the linked run",
					expected: "A grounded answer",
				},
				source_run_id: runId,
				suite,
				version: {
					created_at: PROOF_TIME,
					id: "version-trace-proof",
					label: "Trace import",
					suite_id: suiteId,
				},
			});
		}

		record(method, url, body, 404);
		return jsonResponse(
			{ message: `No fixture for ${method} ${url.pathname}` },
			404
		);
	};
}

function AgentObservabilityProof() {
	return (
		<main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
			<div className="mx-auto max-w-6xl">
				<header className="mb-6 flex items-start justify-between gap-4 border-b pb-5">
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							Production component proof
						</p>
						<h1 className="mt-2 font-semibold text-3xl tracking-tight">
							Agent observability
						</h1>
						<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
							Live audit rollups, searchable events, and correlated Core spans
							for one agent.
						</p>
					</div>
					<div
						className="rounded-full border border-success/30 bg-success/10 px-3 py-1.5 font-semibold text-success text-xs"
						data-testid="proof-status"
					>
						Production UI mounted
					</div>
				</header>
				<AgentObservabilityView
					agentId={AGENT_ID}
					defaultModel="gpt-4o-mini"
					onOpenRun={(conversationId) => {
						document.body.dataset.openedRun = conversationId;
					}}
					target={TARGET}
				/>
			</div>
		</main>
	);
}

installProofApi();
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={queryClient}>
		<AgentObservabilityProof />
	</QueryClientProvider>
);
