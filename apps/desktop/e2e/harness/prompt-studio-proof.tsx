import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { PromptStudio } from "../../src/components/PromptStudio.tsx";
import type {
	EvalCaseScore,
	EvalRunResult,
} from "../../src/lib/api/gateway.ts";
import {
	type PluginValue,
	pluginBooleanField,
	pluginRecord,
	pluginStringField,
} from "../../src/lib/api/plugin-wire-values.ts";
import { parseProofJson } from "../fixture-json.ts";
import {
	type CapturedPromptStudioRequest,
	labelSaveFixtureSchema,
	nameSaveFixtureSchema,
	type PromptReviewFixture,
	type PromptRunFixture,
	type PromptStudioFixtureHooks,
	type PromptSuiteFixture,
	type PromptSuiteVersionFixture,
	type PromptVersionFixture,
	parsePromptStudioFixtureState,
	promptVersionSaveFixtureSchema,
	runSaveFixtureSchema,
	suiteSaveFixtureSchema,
} from "../prompt-studio-fixture-contract.ts";
import styles from "./prompt-studio-proof.module.css";
import "../../src/index.css";

const TARGET = { token: null, url: "http://127.0.0.1:8780" };
const AGENT_ID = "prompt-studio-proof-agent";
const STORAGE_KEY = "prompt-studio-proof-api-state";

declare global {
	interface Window {
		__promptStudioProof: PromptStudioFixtureHooks;
	}
}

let savedPrompt = "You are a concise assistant.\n\nUse {{topic}}.";
let currentDraft = savedPrompt;
let runCounter = 0;
let proofRuns = new Map<string, PromptRunFixture>();
let savedReviews = new Map<string, PromptReviewFixture>();
let savedSuiteName = "Promptfoo regression suite";
let savedSuiteConfig: PluginValue = {};
let savedSuiteRecord: PromptSuiteFixture | null = null;
let suiteVersions: PromptSuiteVersionFixture[] = [];
let promptVersions: PromptVersionFixture[] = [];

const EVAL_CASES: EvalCaseScore[] = [
	{
		assertion_score: 1,
		assertions: [
			{
				detail: 'found one of the values: "concise"',
				executed: true,
				kind: "icontains_any",
				pass: true,
				score: 1,
			},
			{
				detail: "judge verdict: PASS SCORE: 0.9",
				executed: true,
				kind: "llm_rubric",
				pass: true,
				score: 0.9,
			},
		],
		assertions_pass: true,
		cache_hit: false,
		cost_micro_usd: 2400,
		description: "Concise answer",
		evaluators: [
			{
				category: "quality",
				detail: "exact match",
				executed: true,
				id: "exact_match",
				pass: true,
				score: 1,
			},
		],
		id: "case-concise",
		input_tokens: 42,
		latency_ms: 640,
		latency_score: 0.94,
		metadata: { locale: "en", team: "support" },
		overall: 0.88,
		policy_pass: true,
		prompt: "Explain topic: prompt engineering",
		prompt_id: "primary",
		provider: "openai",
		rendered_prompt:
			"You are a concise assistant. Explain topic: prompt engineering",
		response_text: "A concise explanation of prompt engineering.",
		substring_match: 1,
		token_efficiency: 0.72,
		total_tokens: 60,
		vars: { topic: "prompt engineering" },
	},
	{
		assertion_score: 0,
		assertions: [
			{
				detail: 'missing one of the values: "concise"',
				executed: true,
				kind: "icontains_any",
				pass: false,
				score: 0,
			},
		],
		assertions_pass: false,
		cache_hit: false,
		cost_micro_usd: 1800,
		description: "Avoid a verbose answer",
		evaluators: [],
		id: "case-brief",
		input_tokens: 38,
		latency_available: false,
		latency_ms: 1240,
		latency_score: 0.72,
		metadata: { locale: "fr", team: "billing", severity: "review" },
		overall: 0.42,
		policy_available: false,
		policy_pass: true,
		prompt: "Give a brief answer about prompt engineering",
		prompt_id: "primary",
		provider: "openai",
		rendered_prompt:
			"You are a concise assistant. Give a brief answer about prompt engineering",
		response_text:
			'{"answer":"Prompt engineering is writing instructions for a model."}',
		substring_match: 0,
		token_efficiency: 0.5,
		total_tokens: 54,
		vars: { topic: "prompt engineering" },
	},
];

function modelCases(model: string): EvalCaseScore[] {
	return EVAL_CASES.map((score, index) => {
		const result: EvalCaseScore = {
			...score,
			model,
			response_text:
				model === "gpt-4o-mini"
					? score.response_text
					: index === 0
						? "Prompt engineering is a method for writing model instructions."
						: "Use **clear** instructions and examples when prompting a model.",
			overall:
				model === "gpt-4o-mini" ? score.overall : index === 0 ? 0.79 : 0.68,
			prompt_id: "primary",
		};
		if (model === "gpt-4.1-mini") {
			result.latency_available = false;
			result.policy_available = false;
		}
		return result;
	});
}

function aggregateFor(model: string) {
	const cases = modelCases(model);
	return {
		assertion_pass_rate: model === "gpt-4o-mini" ? 0.5 : 0,
		evaluators: {},
		mean_latency: model === "gpt-4o-mini" ? 0.83 : 0.78,
		mean_overall: model === "gpt-4o-mini" ? 0.65 : 0.735,
		mean_substring_match: 0.5,
		mean_token_efficiency: 0.61,
		policy_pass_rate: 1,
		latency_available_cases:
			model === "gpt-4o-mini"
				? cases.filter((score) => score.latency_available !== false).length
				: 0,
		policy_available_cases:
			model === "gpt-4o-mini"
				? cases.filter((score) => score.policy_available !== false).length
				: 0,
		total_cases: cases.length,
		total_cost_micro_usd: model === "gpt-4o-mini" ? 4200 : 3600,
		total_input_tokens: cases.reduce(
			(sum, score) => sum + (score.input_tokens ?? 0),
			0
		),
		total_output_tokens: cases.reduce(
			(sum, score) => sum + (score.output_tokens ?? 0),
			0
		),
	};
}

const EVAL_RESULT: EvalRunResult = {
	aggregate: aggregateFor("gpt-4o-mini"),
	cases: modelCases("gpt-4o-mini"),
	models: [
		{
			aggregate: aggregateFor("gpt-4o-mini"),
			cases: modelCases("gpt-4o-mini"),
			model: "gpt-4o-mini",
		},
		{
			aggregate: aggregateFor("gpt-4.1-mini"),
			cases: modelCases("gpt-4.1-mini"),
			model: "gpt-4.1-mini",
		},
	],
};

function persistFixtureState(): void {
	const state = {
		agentVersions: promptVersions,
		prompt: savedPrompt,
		reviews: [...savedReviews],
		runCounter,
		runs: [...proofRuns.values()],
		suite: savedSuiteRecord,
		suiteVersions,
	};
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// The browser proof does not treat full/disabled storage as a product error.
	}
}

function restoreFixtureState(): void {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return;
		}
		const stored = parsePromptStudioFixtureState(raw);
		savedPrompt = stored.prompt ?? savedPrompt;
		currentDraft = savedPrompt;
		promptVersions = stored.agentVersions ?? [];
		savedSuiteRecord = stored.suite ?? null;
		savedSuiteName = savedSuiteRecord?.name ?? savedSuiteName;
		savedSuiteConfig = savedSuiteRecord?.config ?? {};
		suiteVersions = stored.suiteVersions ?? [];
		proofRuns = new Map((stored.runs ?? []).map((run) => [run.id, run]));
		runCounter = stored.runCounter ?? 0;
		savedReviews = new Map(stored.reviews ?? []);
	} catch {
		localStorage.removeItem(STORAGE_KEY);
	}
}

function jsonResponse<FixturePayload>(
	value: FixturePayload,
	status = 200
): Response {
	persistFixtureState();
	return new Response(JSON.stringify(value), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

function installProofApi(): void {
	const params = new URLSearchParams(window.location.search);
	let holdInitialSuiteList = params.get("holdSuiteList") === "true";
	if (params.get("reset") === "true") {
		localStorage.removeItem(STORAGE_KEY);
		params.delete("reset");
		const remainingQuery = params.toString();
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${remainingQuery ? `?${remainingQuery}` : ""}`
		);
	}
	restoreFixtureState();
	const requests: CapturedPromptStudioRequest[] = [];
	let nextFailure = "";
	let holdRun = false;
	let holdPreviewChat = false;
	let abortedRuns = 0;
	let abortedPreviewChats = 0;
	let releaseSuiteList: (() => void) | null = null;
	window.__promptStudioProof = {
		armFailure(operation) {
			nextFailure = operation;
		},
		holdNextEvalRun() {
			holdRun = true;
		},
		holdNextPreviewChat() {
			holdPreviewChat = true;
		},
		releaseInitialSuiteList() {
			releaseSuiteList?.();
			releaseSuiteList = null;
		},
		snapshot() {
			return structuredClone({
				abortedRuns,
				abortedPreviewChats,
				draft: currentDraft,
				prompt: savedPrompt,
				promptVersions,
				requests,
				reviews: Object.fromEntries(savedReviews),
				runs: [...proofRuns.values()],
				suite: savedSuiteRecord,
				suiteVersions,
			});
		},
	};
	const consumeFailure = (operation: string): boolean => {
		if (nextFailure !== operation) {
			return false;
		}
		nextFailure = "";
		return true;
	};
	const toBody = (init?: RequestInit): PluginValue => {
		const body = z.string().safeParse(init?.body);
		if (!body.success) {
			return null;
		}
		try {
			return parseProofJson(body.data);
		} catch {
			return body.data;
		}
	};
	const reviewsFor = (runId: string) =>
		[...savedReviews.values()].filter((review) => review.run_id === runId);
	const runMeta = ({ created_at, id, name, suite_id }: PromptRunFixture) => ({
		created_at,
		id,
		name,
		suite_id,
	});

	window.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
		const [input, init] = args;
		const rawUrl =
			input instanceof Request
				? input.url
				: input instanceof URL
					? input.toString()
					: String(input);
		const url = new URL(rawUrl, window.location.href);
		const { pathname } = url;
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		const body = toBody(init);
		requests.push({ body, method, path: pathname });

		if (pathname === "/api/gateway/evals/run" && method === "POST") {
			if (consumeFailure("eval-run")) {
				return jsonResponse({ message: "Fixture evaluation failed." }, 503);
			}
			if (holdRun) {
				holdRun = false;
				return await new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (signal?.aborted) {
						abortedRuns += 1;
						reject(new DOMException("The request was aborted.", "AbortError"));
						return;
					}
					signal?.addEventListener(
						"abort",
						() => {
							abortedRuns += 1;
							reject(
								new DOMException("The request was aborted.", "AbortError")
							);
						},
						{ once: true }
					);
				});
			}
			return jsonResponse(EVAL_RESULT);
		}

		if (pathname === "/api/chat/stream" && method === "POST") {
			if (consumeFailure("preview-chat")) {
				return jsonResponse({ message: "Fixture preview failed." }, 503);
			}
			if (holdPreviewChat) {
				holdPreviewChat = false;
				return await new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (signal?.aborted) {
						abortedPreviewChats += 1;
						reject(new DOMException("The request was aborted.", "AbortError"));
						return;
					}
					signal?.addEventListener(
						"abort",
						() => {
							abortedPreviewChats += 1;
							reject(
								new DOMException("The request was aborted.", "AbortError")
							);
						},
						{ once: true }
					);
				});
			}
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					controller.enqueue(
						encoder.encode(
							'data: {"type":"text-start","id":"preview-message"}\n\n'
						)
					);
					controller.enqueue(
						encoder.encode(
							'data: {"type":"text-delta","id":"preview-message","delta":"Preview fixture response."}\n\n'
						)
					);
					controller.enqueue(
						encoder.encode(
							'data: {"type":"text-end","id":"preview-message"}\n\n'
						)
					);
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				},
			});
			return new Response(stream, {
				headers: { "content-type": "text/event-stream" },
			});
		}

		const promptVersionPath = pathname.match(
			new RegExp(
				`^/api/agents/${AGENT_ID}/prompt-versions(?:/([^/]+))?(?:/(restore))?$`
			)
		);
		if (promptVersionPath) {
			const versionId = promptVersionPath[1]
				? decodeURIComponent(promptVersionPath[1])
				: null;
			const restore = promptVersionPath[2] === "restore";
			if (restore && method === "POST" && versionId) {
				const version = promptVersions.find((item) => item.id === versionId);
				if (!version) {
					return jsonResponse({ message: "Prompt version not found." }, 404);
				}
				savedPrompt = String(version.prompt ?? savedPrompt);
				return jsonResponse({ prompt: savedPrompt, source: savedPrompt });
			}
			if (versionId && method === "GET") {
				const version = promptVersions.find((item) => item.id === versionId);
				return version
					? jsonResponse({
							version: { prompt: version.prompt, source: version.prompt },
						})
					: jsonResponse({ message: "Prompt version not found." }, 404);
			}
			if (method === "POST") {
				if (consumeFailure("prompt-version-save")) {
					return jsonResponse(
						{ message: "Fixture prompt-version write failed." },
						503
					);
				}
				const input = promptVersionSaveFixtureSchema.parse(body ?? {});
				savedPrompt = input.prompt ?? savedPrompt;
				const version = {
					agent_id: AGENT_ID,
					created_at: Date.now(),
					id: `apv_prompt_studio_proof-${promptVersions.length + 1}`,
					label: input.label ?? null,
					prompt: savedPrompt,
				};
				promptVersions = [version, ...promptVersions];
				return jsonResponse({ version });
			}
			return jsonResponse({ versions: promptVersions });
		}

		if (pathname === "/api/prompt-suites" && method === "GET") {
			if (holdInitialSuiteList) {
				holdInitialSuiteList = false;
				await new Promise<void>((resolve) => {
					releaseSuiteList = resolve;
				});
			}
			return jsonResponse({
				suites: savedSuiteRecord ? [savedSuiteRecord] : [],
			});
		}
		if (pathname === "/api/prompt-suites" && method === "POST") {
			if (consumeFailure("suite-create")) {
				return jsonResponse({ message: "Fixture suite create failed." }, 503);
			}
			const input = suiteSaveFixtureSchema.parse(body ?? {});
			const now = Date.now();
			savedSuiteName = input.name ?? savedSuiteName;
			savedSuiteConfig = input.config ?? {};
			savedSuiteRecord = {
				agent_id: input.agent_id ?? AGENT_ID,
				config: savedSuiteConfig,
				created_at: now,
				id: "ps_prompt_studio_proof",
				name: savedSuiteName,
				updated_at: now,
			};
			const version: PromptSuiteVersionFixture = {
				config: savedSuiteConfig,
				created_at: now,
				id: `psv_prompt_studio_proof-${suiteVersions.length + 1}`,
				label: input.label?.trim() || null,
				suite_id: savedSuiteRecord.id,
			};
			suiteVersions = [version, ...suiteVersions];
			return jsonResponse({ suite: savedSuiteRecord, version });
		}

		const suiteMatch = pathname.match(/^\/api\/prompt-suites\/([^/]+)$/u);
		if (suiteMatch) {
			const suiteId = decodeURIComponent(suiteMatch[1] ?? "");
			if (!savedSuiteRecord || savedSuiteRecord.id !== suiteId) {
				return jsonResponse({ message: "Prompt suite not found." }, 404);
			}
			if (method === "GET") {
				return jsonResponse({ suite: savedSuiteRecord });
			}
			if (method === "PUT") {
				if (consumeFailure("suite-update")) {
					return jsonResponse({ message: "Fixture suite update failed." }, 503);
				}
				const input = suiteSaveFixtureSchema.parse(body ?? {});
				savedSuiteName = input.name ?? savedSuiteName;
				savedSuiteConfig = input.config ?? savedSuiteConfig;
				savedSuiteRecord = {
					...savedSuiteRecord,
					config: savedSuiteConfig,
					name: savedSuiteName,
					updated_at: Date.now(),
				};
				const version: PromptSuiteVersionFixture = {
					config: savedSuiteConfig,
					created_at: Date.now(),
					id: `psv_prompt_studio_proof-${suiteVersions.length + 1}`,
					label: input.label?.trim() || null,
					suite_id: suiteId,
				};
				suiteVersions = [version, ...suiteVersions];
				return jsonResponse({ suite: savedSuiteRecord, version });
			}
			if (method === "DELETE") {
				savedSuiteRecord = null;
				suiteVersions = [];
				proofRuns.clear();
				savedReviews.clear();
				return jsonResponse({});
			}
		}

		const suiteVersionCollection = pathname.match(
			/^\/api\/prompt-suites\/([^/]+)\/versions$/u
		);
		if (suiteVersionCollection) {
			const suiteId = decodeURIComponent(suiteVersionCollection[1] ?? "");
			if (method === "POST" && savedSuiteRecord) {
				const input = labelSaveFixtureSchema.parse(body ?? {});
				const version: PromptSuiteVersionFixture = {
					config: savedSuiteRecord.config,
					created_at: Date.now(),
					id: `psv_prompt_studio_proof-${suiteVersions.length + 1}`,
					label: input.label?.trim() || null,
					suite_id: suiteId,
				};
				suiteVersions = [version, ...suiteVersions];
				return jsonResponse({ version });
			}
			return jsonResponse({ versions: suiteVersions });
		}
		const suiteVersionRoute = pathname.match(
			/^\/api\/prompt-suites\/([^/]+)\/versions\/([^/]+)(?:\/(restore))?$/u
		);
		if (suiteVersionRoute) {
			decodeURIComponent(suiteVersionRoute[1] ?? "");
			const versionId = decodeURIComponent(suiteVersionRoute[2] ?? "");
			const restore = suiteVersionRoute[3] === "restore";
			const version = suiteVersions.find((item) => item.id === versionId);
			if (!(version && savedSuiteRecord)) {
				return jsonResponse(
					{ message: "Prompt suite version not found." },
					404
				);
			}
			if (restore && method === "POST") {
				if (consumeFailure("suite-restore")) {
					return jsonResponse(
						{ message: "Fixture suite restore failed." },
						503
					);
				}
				savedSuiteConfig = version.config;
				savedSuiteRecord = {
					...savedSuiteRecord,
					config: savedSuiteConfig,
					updated_at: Date.now(),
				};
				return jsonResponse({ suite: savedSuiteRecord });
			}
			return jsonResponse({ version });
		}

		const runCollection = pathname.match(
			/^\/api\/prompt-suites\/([^/]+)\/runs$/u
		);
		if (runCollection) {
			const suiteId = decodeURIComponent(runCollection[1] ?? "");
			if (method === "POST") {
				if (consumeFailure("run-save")) {
					return jsonResponse({ message: "Fixture run save failed." }, 503);
				}
				const input = runSaveFixtureSchema.parse(body ?? {});
				runCounter += 1;
				const run: PromptRunFixture = {
					created_at: Date.now(),
					id: `pr_prompt_studio_proof-${runCounter}`,
					name: input.name ?? `Prompt Studio run ${runCounter}`,
					request: input.request ?? {},
					result: input.result ?? { variants: [] },
					suite_id: suiteId,
				};
				proofRuns.set(run.id, run);
				return jsonResponse({ run: runMeta(run) });
			}
			return jsonResponse({
				runs: [...proofRuns.values()]
					.filter((run) => run.suite_id === suiteId)
					.map(runMeta),
			});
		}
		const runRoute = pathname.match(
			/^\/api\/prompt-suites\/([^/]+)\/runs\/([^/]+)(?:\/(duplicate|reviews))?$/u
		);
		if (runRoute) {
			const suiteId = decodeURIComponent(runRoute[1] ?? "");
			const runId = decodeURIComponent(runRoute[2] ?? "");
			const action = runRoute[3] ?? "";
			const run = proofRuns.get(runId);
			if (action === "reviews") {
				if (method === "POST") {
					if (consumeFailure("review-save")) {
						return jsonResponse(
							{ message: "Fixture review save failed." },
							503
						);
					}
					const input = pluginRecord(body) ?? {};
					const review: PromptReviewFixture = {
						comment: pluginStringField(input.comment) ?? null,
						highlighted: input.highlighted === true,
						pass: pluginBooleanField(input.pass) ?? null,
						result_key: String(input.result_key ?? ""),
						run_id: runId,
						score: z.number().safeParse(input.score).data ?? null,
						updated_at: Date.now(),
					};
					savedReviews.set(`${runId}:${review.result_key}`, review);
					return jsonResponse({ review });
				}
				return jsonResponse({ reviews: reviewsFor(runId) });
			}
			if (action === "duplicate" && method === "POST") {
				if (consumeFailure("run-duplicate")) {
					return jsonResponse(
						{ message: "Fixture run duplicate failed." },
						503
					);
				}
				if (!run) {
					return jsonResponse({ message: "Prompt run not found." }, 404);
				}
				runCounter += 1;
				const duplicate: PromptRunFixture = {
					...run,
					created_at: Date.now(),
					id: `${run.id}-copy-${runCounter}`,
					name: `${run.name} copy`,
				};
				proofRuns.set(duplicate.id, duplicate);
				return jsonResponse({ run: runMeta(duplicate) });
			}
			if (method === "DELETE") {
				if (consumeFailure("run-delete")) {
					return jsonResponse({ message: "Fixture run delete failed." }, 503);
				}
				proofRuns.delete(runId);
				for (const key of savedReviews.keys()) {
					if (key.startsWith(`${runId}:`)) {
						savedReviews.delete(key);
					}
				}
				return jsonResponse({});
			}
			if (method === "PUT") {
				if (consumeFailure("run-rename")) {
					return jsonResponse({ message: "Fixture run rename failed." }, 503);
				}
				if (!run) {
					return jsonResponse({ message: "Prompt run not found." }, 404);
				}
				const input = nameSaveFixtureSchema.parse(body ?? {});
				run.name = input.name ?? run.name;
				return jsonResponse({ run: runMeta(run) });
			}
			if (!run || run.suite_id !== suiteId) {
				return jsonResponse({ message: "Prompt run not found." }, 404);
			}
			if (consumeFailure("run-load")) {
				return jsonResponse({ message: "Fixture run load failed." }, 503);
			}
			return jsonResponse({ run });
		}

		return jsonResponse({});
	}, window.fetch);
}

function PromptStudioProof() {
	const [prompt, setPrompt] = useState(savedPrompt);
	const onPromptChange = useCallback((value: string) => {
		currentDraft = value;
		setPrompt(value);
	}, []);
	const params = new URLSearchParams(window.location.search);
	const locked = params.get("locked") === "true";
	const engine = params.get("engine") ?? "openai_compat";
	const agentId = params.get("agent") === "none" ? null : AGENT_ID;
	const model = params.get("model") ?? "gpt-4o-mini";

	return (
		<main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
			<div className="mx-auto max-w-5xl">
				<header className="mb-6 flex items-start justify-between gap-4 border-b pb-5">
					<div>
						<p
							className={`${styles.eyebrow} font-medium text-muted-foreground text-xs uppercase`}
						>
							Production component proof
						</p>
						<h1 className="mt-2 font-semibold text-3xl tracking-tight">
							Prompt Studio
						</h1>
						<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
							Prompt editing, durable history, Promptfoo-style assertions,
							thresholds, and model comparison.
						</p>
					</div>
					<div
						className={`${styles.mountedStatus} rounded-full border px-3 py-1.5 font-semibold text-xs`}
						data-testid="proof-status"
					>
						Production UI mounted
					</div>
				</header>
				<TooltipProvider delay={0}>
					<PromptStudio
						agentId={agentId}
						engine={engine}
						locked={locked}
						model={model}
						onChange={onPromptChange}
						target={TARGET}
						value={prompt}
						version="1.2.0"
					/>
				</TooltipProvider>
			</div>
		</main>
	);
}

installProofApi();
const root = document.getElementById("root");
if (!root) {
	throw new Error("Prompt Studio fixture root is missing.");
}
createRoot(root).render(<PromptStudioProof />);
