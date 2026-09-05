// apps/desktop/src/components/PromptStudio.tsx
//
// Prompt Studio - a focused authoring surface for agent system prompts.
// Provides a multi-line prompt editor with variable placeholder support
// ({{variable_name}} syntax), a one-shot preview that runs the draft prompt
// against the agent's bound engine, AND a promptfoo-style Test-cases runner.
//
// The preview works by sending the draft prompt as a user message framing,
// since `ChatStreamRequest` has no system_prompt override field. The agent's
// bound engine handles the actual inference.
//
// The Test-cases runner is the gateway-backed path: it sends the draft prompt as
// `system_prompt` (the server substitutes {{vars}} per case and prepends it as a
// system message), the cases as `dataset` (with per-case vars + assertions), and
// the selected model(s). Results are rendered as a per-case × per-model matrix
// with per-assertion pass/fail chips. Prompt history is stored by Core so it is
// durable and shared across desktop sessions.

import { useChat } from "@ai-sdk/react";
import {
	Add01Icon,
	Cancel01Icon,
	Delete02Icon,
	LockedIcon,
	PlayIcon,
	Square01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select";
import { Textarea } from "@ryu/ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownEditor } from "@/src/components/editor/MarkdownEditor.tsx";
import { VersionHistory } from "@/src/components/versioning/VersionHistory.tsx";
import {
	createAgentPromptVersion,
	getAgentPromptVersion,
	listAgentPromptVersions,
	restoreAgentPromptVersion,
} from "@/src/lib/api/agents.ts";
import { chatHeaders, chatStreamUrl } from "@/src/lib/api/chat.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type Assertion,
	type AssertionOptions,
	type AssertionResult,
	type EvalCaseScore,
	type EvalDatasetCase,
	type EvalMessage,
	type EvalRunResult,
	type ModelEvalResult,
	runGatewayEvals,
} from "@/src/lib/api/gateway.ts";
import {
	createPromptSuite,
	getPromptRun,
	listPromptRuns,
	listPromptSuites,
	listPromptSuiteVersions,
	type PromptRunMeta,
	type PromptSuiteRecord,
	type PromptSuiteVersionMeta,
	restorePromptSuiteVersion,
	savePromptReview,
	savePromptRun,
	updatePromptSuite,
} from "@/src/lib/api/prompt-suites.ts";
import { instrumentedFetch } from "@/src/lib/dev-metrics.ts";
import {
	normalizePromptfooConfig,
	type PromptfooConfig,
	type PromptfooPrompt,
	type PromptfooTest,
	parsePromptfooFile,
	serializePromptfooConfig,
} from "@/src/lib/promptfoo.ts";

// ── Variable placeholder detection ────────────────────────────────────────────
// Named placeholders in {{variable_name}} syntax. A top-level regex (not created
// inside a loop) per the code standards.
const PLACEHOLDER_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

// Large-matrix warning threshold (models × cases). Multi-model × llm_judge fans
// out to sequential provider calls under Core's 120s proxy timeout.
const LARGE_MATRIX_THRESHOLD = 12;

function extractPlaceholders(prompt: string): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const match of prompt.matchAll(PLACEHOLDER_RE)) {
		const name = match[1];
		if (!seen.has(name)) {
			seen.add(name);
			result.push(name);
		}
	}
	return result;
}

function renderPrompt(prompt: string, vars: Record<string, string>): string {
	return prompt.replace(
		PLACEHOLDER_RE,
		(_, name: string) => vars[name] ?? `{{${name}}}`
	);
}

function displayVariable(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (value === undefined) {
		return "";
	}
	return JSON.stringify(value);
}

function parseVariable(value: string): unknown {
	const trimmed = value.trim();
	if (!trimmed) {
		return "";
	}
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return value;
	}
}

function pct(value: number): string {
	return `${Math.round(value * 100)}%`;
}

function scoreTone(score: number): string {
	if (score >= 0.75) {
		return "text-success dark:text-success";
	}
	if (score >= 0.5) {
		return "text-warning dark:text-warning";
	}
	return "text-destructive";
}

function parseThreshold(value: string): number | undefined {
	if (!value.trim()) {
		return undefined;
	}
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : undefined;
}

// ── Assertion kinds (UI metadata) ──────────────────────────────────────────────

const ASSERTION_KINDS = [
	"contains",
	"not_contains",
	"equals",
	"regex",
	"icontains",
	"starts_with",
	"contains_any",
	"contains_all",
	"icontains_any",
	"icontains_all",
	"contains_json",
	"is_html",
	"is_xml",
	"is_sql",
	"is_refusal",
	"moderation",
	"javascript",
	"python",
	"ruby",
	"webhook",
	"is_json",
	"json_valid",
	"llm_judge",
	"llm_rubric",
	"factuality",
	"context_faithfulness",
	"answer_relevance",
] as const;

type AssertionKind = (typeof ASSERTION_KINDS)[number];

const ASSERTION_LABELS: Record<AssertionKind, string> = {
	contains: "Contains",
	not_contains: "Not contains",
	equals: "Equals",
	regex: "Regex",
	icontains: "Contains (case-insensitive)",
	starts_with: "Starts with",
	contains_any: "Contains any",
	contains_all: "Contains all",
	icontains_any: "Contains any (case-insensitive)",
	icontains_all: "Contains all (case-insensitive)",
	contains_json: "Contains JSON",
	is_html: "HTML",
	is_xml: "XML",
	is_sql: "SQL",
	is_refusal: "Refusal",
	moderation: "Moderation",
	javascript: "JavaScript",
	python: "Python",
	ruby: "Ruby",
	webhook: "Webhook",
	is_json: "Valid JSON",
	json_valid: "Valid JSON",
	llm_judge: "LLM judge",
	llm_rubric: "LLM rubric",
	factuality: "Factuality",
	context_faithfulness: "Context faithfulness",
	answer_relevance: "Answer relevance",
};

/** Build a default assertion object for a given kind. */
function defaultAssertion(kind: AssertionKind): Assertion {
	if (
		[
			"json_valid",
			"is_json",
			"is_html",
			"is_xml",
			"is_sql",
			"is_refusal",
		].includes(kind)
	) {
		return { kind } as Assertion;
	}
	if (
		[
			"llm_judge",
			"llm_rubric",
			"factuality",
			"context_faithfulness",
			"answer_relevance",
		].includes(kind)
	) {
		return { kind, rubric: "" } as Assertion;
	}
	return { kind, value: "" } as Assertion;
}

/** The editable text payload of an assertion (value or rubric), if any. */
function assertionText(a: Assertion): string {
	if (
		[
			"json_valid",
			"is_json",
			"is_html",
			"is_xml",
			"is_sql",
			"is_refusal",
		].includes(a.kind)
	) {
		return "";
	}
	if (
		[
			"llm_judge",
			"llm_rubric",
			"factuality",
			"context_faithfulness",
			"answer_relevance",
		].includes(a.kind)
	) {
		return "rubric" in a ? a.rubric : "";
	}
	return "value" in a ? a.value : "";
}

/** Set the editable text payload of an assertion, preserving kind. */
function withAssertionText(a: Assertion, text: string): Assertion {
	if (
		[
			"json_valid",
			"is_json",
			"is_html",
			"is_xml",
			"is_sql",
			"is_refusal",
		].includes(a.kind)
	) {
		return a;
	}
	if (
		[
			"llm_judge",
			"llm_rubric",
			"factuality",
			"context_faithfulness",
			"answer_relevance",
		].includes(a.kind)
	) {
		return { kind: a.kind, options: a.options, rubric: text } as Assertion;
	}
	return { kind: a.kind, options: a.options, value: text } as Assertion;
}

/** The Gateway wire contract flattens Promptfoo assertion options next to kind/value. */
function gatewayAssertion(assertion: Assertion): Assertion {
	const { options, ...base } = assertion as Assertion & {
		options?: AssertionOptions;
	};
	return { ...base, ...(options ?? {}) } as Assertion;
}

// ── Test-case rows ─────────────────────────────────────────────────────────────

interface TestCaseRow {
	assertions: Assertion[];
	/** Legacy convenience expected substring. */
	expected: string;
	id: string;
	/** User message; may contain {{vars}}. */
	input: string;
	/** Ordered Promptfoo chat messages, when this case is multi-turn. */
	messages?: EvalMessage[];
	metadata: Record<string, unknown>;
	name: string;
	options: Record<string, unknown>;
	providers: string[];
	/** Promptfoo-style mean assertion pass threshold, entered as 0..1. */
	threshold: string;
	vars: Record<string, unknown>;
}

function newTestCaseRow(): TestCaseRow {
	return {
		id: crypto.randomUUID(),
		name: "",
		input: "",
		metadata: {},
		options: {},
		providers: [],
		vars: {},
		expected: "",
		threshold: "",
		assertions: [],
	};
}

interface PromptTestSuiteSnapshot {
	evaluatorIds: string[];
	extraModels: string[];
	judgeModel: string;
	rows: TestCaseRow[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPersistedAssertion(value: unknown): value is Assertion {
	if (!isRecord(value) || typeof value.kind !== "string") {
		return false;
	}
	if (
		[
			"json_valid",
			"is_json",
			"is_html",
			"is_xml",
			"is_sql",
			"is_refusal",
		].includes(value.kind)
	) {
		return true;
	}
	if (
		[
			"llm_judge",
			"llm_rubric",
			"factuality",
			"context_faithfulness",
			"answer_relevance",
		].includes(value.kind)
	) {
		return typeof value.rubric === "string";
	}
	return (
		ASSERTION_KINDS.includes(value.kind as AssertionKind) &&
		typeof value.value === "string"
	);
}

function isPersistedRow(value: unknown): value is TestCaseRow {
	if (!isRecord(value)) {
		return false;
	}
	if (
		typeof value.id !== "string" ||
		typeof value.name !== "string" ||
		typeof value.input !== "string" ||
		typeof value.expected !== "string" ||
		typeof value.threshold !== "string" ||
		!isRecord(value.vars) ||
		!Array.isArray(value.assertions)
	) {
		return false;
	}
	return (
		value.assertions.every(isPersistedAssertion) &&
		(value.messages === undefined || Array.isArray(value.messages)) &&
		(value.metadata === undefined || isRecord(value.metadata)) &&
		(value.options === undefined || isRecord(value.options)) &&
		(value.providers === undefined || Array.isArray(value.providers))
	);
}

function normalizeTestCaseRow(row: TestCaseRow): TestCaseRow {
	return {
		...newTestCaseRow(),
		...row,
		metadata: row.metadata ?? {},
		options: row.options ?? {},
		providers: row.providers ?? [],
		vars: row.vars ?? {},
	};
}

function testSuiteKey(agentId: string): string {
	return `prompt-studio-tests:${agentId}`;
}

function loadTestSuite(agentId: string | null): PromptTestSuiteSnapshot {
	if (!agentId || typeof window === "undefined") {
		return { evaluatorIds: [], extraModels: [], judgeModel: "", rows: [] };
	}
	try {
		const raw = window.localStorage.getItem(testSuiteKey(agentId));
		if (!raw) {
			return { evaluatorIds: [], extraModels: [], judgeModel: "", rows: [] };
		}
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) {
			return { evaluatorIds: [], extraModels: [], judgeModel: "", rows: [] };
		}
		return {
			evaluatorIds: Array.isArray(parsed.evaluatorIds)
				? parsed.evaluatorIds.filter(
						(value): value is string => typeof value === "string"
					)
				: [],
			extraModels: Array.isArray(parsed.extraModels)
				? parsed.extraModels.filter(
						(model): model is string => typeof model === "string"
					)
				: [],
			judgeModel:
				typeof parsed.judgeModel === "string" ? parsed.judgeModel : "",
			rows: Array.isArray(parsed.rows)
				? parsed.rows.filter(isPersistedRow).map(normalizeTestCaseRow)
				: [],
		};
	} catch {
		return { evaluatorIds: [], extraModels: [], judgeModel: "", rows: [] };
	}
}

function persistTestSuite(
	agentId: string,
	snapshot: PromptTestSuiteSnapshot
): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		window.localStorage.setItem(
			testSuiteKey(agentId),
			JSON.stringify(snapshot)
		);
	} catch {
		// Test drafts remain usable when browser storage is unavailable or full.
	}
}

// ── Props ──────────────────────────────────────────────────────────────────────

export interface PromptStudioProps {
	/** The agent id used to send the preview chat request. */
	agentId: string | null;
	/** The execution engine. ACP engines bypass the Gateway eval route. */
	engine?: string;
	/** When true, all editing is disabled. Shows a locked affordance. */
	locked: boolean;
	/**
	 * The agent's selected gateway model used for eval/test runs. Defaults to "".
	 */
	model?: string;
	/** Called when the user edits the prompt text. */
	onChange: (value: string) => void;
	/** Core API target (url + token) for the preview request. */
	target: ApiTarget;
	/** Current draft system prompt value (controlled from the parent). */
	value: string;
	/** Current saved version of the agent. Displayed alongside the editor. */
	version: string;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function PromptStudio({
	value,
	onChange,
	locked,
	agentId,
	target,
	version,
	model = "",
	engine = "",
}: PromptStudioProps) {
	// Variable values entered by the user for the preview substitution.
	const [varValues, setVarValues] = useState<Record<string, string>>({});
	// Whether the preview panel is open.
	const [previewOpen, setPreviewOpen] = useState(false);
	// A stable, ephemeral conversation id per preview session so Core doesn't
	// accumulate junk conversation rows across many preview runs.
	const previewConvIdRef = useRef<string>(`preview-${crypto.randomUUID()}`);

	const placeholders = useMemo(() => extractPlaceholders(value), [value]);
	const promptVersionSource = useMemo(() => {
		if (!agentId) {
			return null;
		}
		return {
			getValue: (versionId: string) =>
				getAgentPromptVersion(target, agentId, versionId),
			list: async () =>
				(await listAgentPromptVersions(target, agentId)).map((saved) => ({
					createdAt: saved.createdAt,
					id: saved.id,
					label: saved.label,
				})),
			restore: async (versionId: string) => {
				const restored = await restoreAgentPromptVersion(
					target,
					agentId,
					versionId
				);
				onChange(restored);
			},
			snapshot: () => createAgentPromptVersion(target, agentId, value),
		};
	}, [agentId, onChange, target, value]);

	// Reset unknown var values when the placeholder set changes — avoid stale keys
	// polluting the rendered prompt.
	// biome-ignore lint/correctness/useExhaustiveDependencies: varValues is read but deliberately excluded to avoid an update loop; only the placeholder set drives the reset.
	useEffect(() => {
		const kept: Record<string, string> = {};
		for (const name of placeholders) {
			kept[name] = varValues[name] ?? "";
		}
		setVarValues(kept);
	}, [placeholders]);

	const handleVarChange = useCallback((name: string, val: string) => {
		setVarValues((prev) => ({ ...prev, [name]: val }));
	}, []);

	const handleOpenPreview = useCallback(() => {
		// Rotate the ephemeral conversation id on each open so Core doesn't confuse
		// repeated previews with a real conversation.
		previewConvIdRef.current = `preview-${crypto.randomUUID()}`;
		setPreviewOpen(true);
	}, []);

	const handleClosePreview = useCallback(() => {
		setPreviewOpen(false);
	}, []);

	return (
		<div className="flex flex-col gap-4">
			{/* Header */}
			<div className="flex items-center gap-2">
				<span className="font-medium text-base">Prompt Studio</span>
				<Badge className="ml-1 text-[10px]" variant="secondary">
					v{version}
				</Badge>
				<div className="ml-auto flex items-center gap-2">
					{promptVersionSource ? (
						<VersionHistory
							currentValue={value}
							disabled={locked}
							source={promptVersionSource}
						/>
					) : null}
					{locked ? (
						<Badge className="gap-1" variant="secondary">
							<HugeiconsIcon className="size-3" icon={LockedIcon} />
							Locked — read only
						</Badge>
					) : null}
				</div>
			</div>

			{locked ? (
				<p className="text-muted-foreground text-xs">
					This agent is locked. Unlock it from the settings before editing the
					system prompt.
				</p>
			) : null}

			{/* Editor */}
			<div className="flex flex-col gap-2">
				<Label htmlFor="prompt-studio-editor">
					System prompt
					{placeholders.length > 0 ? (
						<span className="ml-2 font-normal text-muted-foreground text-xs">
							— {placeholders.length} variable
							{placeholders.length > 1 ? "s" : ""} detected
						</span>
					) : null}
				</Label>
				{locked ? (
					<div
						className="min-h-48 whitespace-pre-wrap rounded-md bg-muted/30 p-3 font-mono text-muted-foreground text-sm"
						id="prompt-studio-editor"
					>
						{value || "No system prompt set."}
					</div>
				) : (
					// Rich Markdown editor (PlateJS) for the agent instructions. Keyed by
					// agent so it re-mounts with fresh content when the agent changes
					// (the editor deserializes initialMarkdown once on mount).
					<div className="rounded-md border" id="prompt-studio-editor">
						<MarkdownEditor
							initialMarkdown={value}
							key={agentId ?? "new"}
							onChangeMarkdown={onChange}
						/>
					</div>
				)}
				<p className="text-muted-foreground text-xs">
					Use{" "}
					<code className="rounded bg-muted px-1 font-mono text-[11px]">
						{"{{variable_name}}"}
					</code>{" "}
					for named placeholders. Fill them in below before previewing.
				</p>
			</div>

			{/* Variable fill-in area */}
			{placeholders.length > 0 ? (
				<div className="flex flex-col gap-3 rounded-lg bg-muted/30 p-3">
					<p className="font-medium text-xs">Preview variables</p>
					<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
						{placeholders.map((name) => (
							<div className="flex flex-col gap-1" key={name}>
								<Label className="text-xs" htmlFor={`var-${name}`}>
									{name}
								</Label>
								<Input
									autoComplete="off"
									className="h-8 text-xs"
									id={`var-${name}`}
									name={`preview-variable-${name}`}
									onChange={(e) => handleVarChange(name, e.target.value)}
									placeholder={`Value for {{${name}}}`}
									value={varValues[name] ?? ""}
								/>
							</div>
						))}
					</div>
				</div>
			) : null}

			{/* Test-cases runner (gateway-backed, system-prompt-aware) */}
			<PromptTestCases
				agentId={agentId}
				engine={engine}
				locked={locked}
				model={model}
				onPromptChange={onChange}
				promptDraft={value}
				target={target}
			/>

			{/* Preview trigger */}
			<div className="flex items-center gap-2">
				<Button
					disabled={!(agentId && value.trim())}
					onClick={handleOpenPreview}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3" icon={PlayIcon} />
					Preview prompt
				</Button>
				{previewOpen ? (
					<Button onClick={handleClosePreview} size="sm" variant="ghost">
						<HugeiconsIcon className="size-3" icon={Cancel01Icon} />
						Close preview
					</Button>
				) : null}
			</div>

			{/* Inline preview panel */}
			{previewOpen && agentId ? (
				<PreviewPanel
					agentId={agentId}
					convId={previewConvIdRef.current}
					prompt={renderPrompt(value, varValues)}
					target={target}
				/>
			) : null}
		</div>
	);
}

// ── Test-cases runner ──────────────────────────────────────────────────────────

interface PromptTestCasesProps {
	agentId: string | null;
	engine: string;
	locked: boolean;
	model: string;
	onPromptChange: (value: string) => void;
	promptDraft: string;
	target: ApiTarget;
}

interface PromptVariantRow {
	content: string;
	id: string;
	messages: EvalMessage[];
	name: string;
	type: "chat" | "text";
}

interface PromptVariantRun {
	promptId: string;
	promptName: string;
	result: EvalRunResult;
}

function promptVariantFromConfig(prompt: PromptfooPrompt): PromptVariantRow {
	return {
		content: prompt.content,
		id: prompt.id,
		messages: prompt.messages,
		name: prompt.name,
		type: prompt.type,
	};
}

function promptfooTestToRow(test: PromptfooTest, index: number): TestCaseRow {
	return {
		assertions: test.assertions,
		expected: test.expected ?? "",
		id: crypto.randomUUID(),
		input: test.prompt ?? "",
		messages: test.messages,
		metadata: test.metadata,
		name: test.description || `Case ${index + 1}`,
		options: test.options,
		providers: test.providers,
		threshold: test.threshold === undefined ? "" : String(test.threshold),
		vars: test.vars,
	};
}

function rowToPromptfooTest(row: TestCaseRow): PromptfooTest {
	return {
		assertions: row.assertions,
		description: row.name,
		expected: row.expected.trim() || undefined,
		messages: row.messages,
		metadata: row.metadata,
		options: row.options,
		prompt: row.input || undefined,
		providers: row.providers,
		threshold: parseThreshold(row.threshold),
		vars: row.vars,
	};
}

function suiteConfigFromEditor(
	promptDraft: string,
	variants: PromptVariantRow[],
	rows: TestCaseRow[],
	providers: string[],
	judgeModel: string,
	evaluators: string[]
): PromptfooConfig {
	const prompts: PromptfooPrompt[] = [
		{
			content: promptDraft,
			id: "primary",
			messages: [],
			name: "Primary",
			type: "text",
		},
		...variants,
	];
	return normalizePromptfooConfig({
		evaluators,
		judge_model: judgeModel.trim() || undefined,
		prompts,
		providers,
		tests: rows.map(rowToPromptfooTest),
	});
}

function PromptTestCases({
	promptDraft,
	agentId,
	target,
	model,
	engine,
	locked,
	onPromptChange,
}: PromptTestCasesProps) {
	const localSuite = useMemo(() => loadTestSuite(agentId), [agentId]);
	const [rows, setRows] = useState<TestCaseRow[]>(() => localSuite.rows);
	const [extraModels, setExtraModels] = useState<string[]>(
		() => localSuite.extraModels
	);
	const [newModel, setNewModel] = useState("");
	const [judgeModel, setJudgeModel] = useState(() => localSuite.judgeModel);
	const [evaluatorIds, setEvaluatorIds] = useState<string[]>(
		() => localSuite.evaluatorIds
	);
	const [suite, setSuite] = useState<PromptSuiteRecord | null>(null);
	const [suiteName, setSuiteName] = useState("Promptfoo regression suite");
	const [suiteVersions, setSuiteVersions] = useState<PromptSuiteVersionMeta[]>(
		[]
	);
	const [suiteRuns, setSuiteRuns] = useState<PromptRunMeta[]>([]);
	const [suiteLoading, setSuiteLoading] = useState(false);
	const [suiteSaving, setSuiteSaving] = useState(false);
	const [suiteError, setSuiteError] = useState<string | null>(null);
	const [saveLabel, setSaveLabel] = useState("");
	const [exportFormat, setExportFormat] = useState<
		"csv" | "json" | "jsonl" | "yaml"
	>("yaml");
	const [variants, setVariants] = useState<PromptVariantRow[]>([]);
	const [running, setRunning] = useState(false);
	const [results, setResults] = useState<PromptVariantRun[] | null>(null);
	const [activeRunId, setActiveRunId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const loadedSuiteAgentRef = useRef<string | null>(null);

	useEffect(() => () => abortRef.current?.abort(), []);

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			loadedSuiteAgentRef.current = null;
			setSuiteLoading(true);
			setSuiteError(null);
			setResults(null);
			setActiveRunId(null);
			try {
				if (!agentId) {
					return;
				}
				const suites = await listPromptSuites(target, agentId);
				if (cancelled) {
					return;
				}
				const nextSuite = suites[0];
				if (!nextSuite) {
					const local = loadTestSuite(agentId);
					setSuite(null);
					setSuiteName("Promptfoo regression suite");
					setRows(local.rows);
					setExtraModels(local.extraModels);
					setJudgeModel(local.judgeModel);
					setEvaluatorIds(local.evaluatorIds);
					setVariants([]);
					setSuiteVersions([]);
					setSuiteRuns([]);
					return;
				}
				const config = normalizePromptfooConfig(nextSuite.config);
				setSuite(nextSuite);
				setSuiteName(nextSuite.name);
				setRows(config.tests.map(promptfooTestToRow));
				setExtraModels(config.providers);
				setJudgeModel(
					typeof config.judge_model === "string" ? config.judge_model : ""
				);
				setEvaluatorIds(
					Array.isArray(config.evaluators)
						? config.evaluators.filter(
								(value): value is string => typeof value === "string"
							)
						: []
				);
				setVariants(config.prompts.slice(1).map(promptVariantFromConfig));
				if (config.prompts[0]?.content) {
					onPromptChange(config.prompts[0].content);
				}
				const [versions, runs] = await Promise.all([
					listPromptSuiteVersions(target, nextSuite.id),
					listPromptRuns(target, nextSuite.id),
				]);
				if (!cancelled) {
					setSuiteVersions(versions);
					setSuiteRuns(runs);
				}
			} catch (loadError) {
				if (!cancelled) {
					// Core may be on an older build while the editor is being upgraded;
					// preserve the local draft and surface the durable-sync state.
					const local = agentId ? loadTestSuite(agentId) : null;
					if (local) {
						setRows(local.rows);
						setExtraModels(local.extraModels);
						setJudgeModel(local.judgeModel);
						setEvaluatorIds(local.evaluatorIds);
					}
					setSuiteError(
						loadError instanceof Error
							? `Durable suite unavailable: ${loadError.message}`
							: "Durable suite unavailable"
					);
				}
			} finally {
				if (!cancelled) {
					setSuiteLoading(false);
					loadedSuiteAgentRef.current = agentId;
				}
			}
		};
		load().catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [agentId, onPromptChange, target]);

	useEffect(() => {
		if (!agentId || loadedSuiteAgentRef.current !== agentId) {
			return;
		}
		persistTestSuite(agentId, { evaluatorIds, extraModels, judgeModel, rows });
	}, [agentId, evaluatorIds, extraModels, judgeModel, rows]);

	// The full model list for this run: the agent's model plus any extras.
	const selectedModels = useMemo(() => {
		const all = [model, ...extraModels].map((m) => m.trim()).filter(Boolean);
		return Array.from(new Set(all));
	}, [model, extraModels]);
	const promptVariants = useMemo<PromptVariantRow[]>(
		() => [
			{
				content: promptDraft,
				id: "primary",
				messages: [],
				name: "Primary",
				type: "text",
			},
			...variants,
		],
		[promptDraft, variants]
	);

	const isAcp = engine.startsWith("acp:");
	const matrixSize =
		selectedModels.length * Math.max(rows.length, 1) * promptVariants.length;
	const largeMatrix = matrixSize > LARGE_MATRIX_THRESHOLD;

	const runDisabled = running || !agentId || !model.trim() || isAcp || locked;

	const addRow = useCallback(() => {
		setRows((prev) => [...prev, newTestCaseRow()]);
	}, []);

	const removeRow = useCallback((id: string) => {
		setRows((prev) => prev.filter((r) => r.id !== id));
	}, []);

	const updateRow = useCallback((id: string, patch: Partial<TestCaseRow>) => {
		setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
	}, []);

	const addVariant = useCallback(() => {
		setVariants((prev) => [
			...prev,
			{
				content: promptDraft,
				id: `prompt-${crypto.randomUUID()}`,
				messages: [],
				name: `Variant ${prev.length + 1}`,
				type: "text",
			},
		]);
	}, [promptDraft]);

	const updateVariant = useCallback(
		(id: string, patch: Partial<PromptVariantRow>) => {
			setVariants((prev) =>
				prev.map((variant) =>
					variant.id === id ? { ...variant, ...patch } : variant
				)
			);
		},
		[]
	);

	const removeVariant = useCallback((id: string) => {
		setVariants((prev) => prev.filter((variant) => variant.id !== id));
	}, []);

	const addExtraModel = useCallback(() => {
		const m = newModel.trim();
		if (!m) {
			return;
		}
		setExtraModels((prev) => (prev.includes(m) ? prev : [...prev, m]));
		setNewModel("");
	}, [newModel]);

	const removeExtraModel = useCallback((m: string) => {
		setExtraModels((prev) => prev.filter((x) => x !== m));
	}, []);

	const applyConfig = useCallback(
		(config: PromptfooConfig) => {
			setRows(config.tests.map(promptfooTestToRow));
			setExtraModels(config.providers);
			setJudgeModel(
				typeof config.judge_model === "string" ? config.judge_model : ""
			);
			setEvaluatorIds(
				Array.isArray(config.evaluators)
					? config.evaluators.filter(
							(value): value is string => typeof value === "string"
						)
					: []
			);
			setVariants(config.prompts.slice(1).map(promptVariantFromConfig));
			if (config.prompts[0]?.content !== undefined) {
				onPromptChange(config.prompts[0].content);
			}
		},
		[onPromptChange]
	);

	const importFile = useCallback(
		async (event: React.ChangeEvent<HTMLInputElement>) => {
			const file = event.target.files?.[0];
			event.target.value = "";
			if (!file) {
				return;
			}
			try {
				const parsed = parsePromptfooFile(await file.text(), file.name);
				applyConfig(parsed.config);
				setSuiteName(file.name.replace(/\.[^.]+$/, "") || "Imported suite");
				setSuite(null);
				setSuiteVersions([]);
				setSuiteRuns([]);
				setSuiteError(null);
			} catch (importError) {
				setSuiteError(
					importError instanceof Error
						? `Import failed: ${importError.message}`
						: "Import failed"
				);
			}
		},
		[applyConfig]
	);

	const saveSuite = useCallback(async () => {
		if (!agentId || locked) {
			return;
		}
		setSuiteSaving(true);
		setSuiteError(null);
		try {
			const config = suiteConfigFromEditor(
				promptDraft,
				variants,
				rows,
				extraModels,
				judgeModel,
				evaluatorIds
			);
			const response = suite
				? await updatePromptSuite(target, suite.id, {
						config,
						label: saveLabel,
						name: suiteName,
					})
				: await createPromptSuite(target, {
						agentId,
						config,
						label: saveLabel,
						name: suiteName,
					});
			setSuite(response.suite);
			if (response.version) {
				setSuiteVersions((prev) => [
					response.version as PromptSuiteVersionMeta,
					...prev,
				]);
			}
			setSaveLabel("");
			setSuiteRuns(await listPromptRuns(target, response.suite.id));
		} catch (saveError) {
			setSuiteError(
				saveError instanceof Error ? saveError.message : "Failed to save suite"
			);
		} finally {
			setSuiteSaving(false);
		}
	}, [
		agentId,
		extraModels,
		judgeModel,
		evaluatorIds,
		locked,
		promptDraft,
		rows,
		saveLabel,
		suite,
		suiteName,
		target,
		variants,
	]);

	const restoreSuiteVersion = useCallback(
		async (versionId: string) => {
			if (!suite || locked) {
				return;
			}
			try {
				const restored = await restorePromptSuiteVersion(
					target,
					suite.id,
					versionId
				);
				setSuite(restored);
				applyConfig(normalizePromptfooConfig(restored.config));
				setSuiteVersions(await listPromptSuiteVersions(target, suite.id));
			} catch (restoreError) {
				setSuiteError(
					restoreError instanceof Error
						? restoreError.message
						: "Failed to restore suite version"
				);
			}
		},
		[applyConfig, locked, suite, target]
	);

	const exportConfig = useCallback(
		(format: "csv" | "json" | "jsonl" | "yaml") => {
			const config = suiteConfigFromEditor(
				promptDraft,
				variants,
				rows,
				extraModels,
				judgeModel,
				evaluatorIds
			);
			const text = serializePromptfooConfig(config, format);
			const link = document.createElement("a");
			link.href = URL.createObjectURL(
				new Blob([text], {
					type: format === "yaml" ? "text/yaml" : "application/json",
				})
			);
			link.download = `${suiteName.trim() || "promptfoo-suite"}.${format}`;
			link.click();
			URL.revokeObjectURL(link.href);
		},
		[
			extraModels,
			evaluatorIds,
			judgeModel,
			promptDraft,
			rows,
			suiteName,
			variants,
		]
	);

	const stop = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	const run = useCallback(async () => {
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		setRunning(true);
		setError(null);
		try {
			const dataset: EvalDatasetCase[] = rows.map((r) => ({
				messages: r.messages,
				prompt: r.input,
				vars: r.vars,
				assertions: r.assertions.map(gatewayAssertion),
				expected: r.expected.trim() ? r.expected : undefined,
				threshold: parseThreshold(r.threshold),
			}));
			const runResults: PromptVariantRun[] = [];
			for (const variant of promptVariants) {
				if (controller.signal.aborted) {
					return;
				}
				const multi = selectedModels.length > 1;
				const res = await runGatewayEvals(
					target,
					{
						agent_id: agentId,
						model,
						models: multi ? selectedModels : undefined,
						system_prompt: variant.content,
						system_messages:
							variant.type === "chat" ? variant.messages : undefined,
						judge_model: judgeModel.trim() || undefined,
						evaluators: evaluatorIds,
						dataset,
					},
					controller.signal
				);
				runResults.push({
					promptId: variant.id,
					promptName: variant.name,
					result: res,
				});
			}
			setResults(runResults);
			if (suite) {
				const saved = await savePromptRun(target, suite.id, {
					name: `${suiteName} · ${new Date().toLocaleString()}`,
					request: {
						dataset,
						judge_model: judgeModel,
						models: selectedModels,
						prompts: promptVariants,
					},
					result: { variants: runResults },
				});
				setActiveRunId(saved.id);
				setSuiteRuns((prev) => [saved, ...prev]);
			}
		} catch (e) {
			if (!controller.signal.aborted) {
				setError(e instanceof Error ? e.message : String(e));
			}
		} finally {
			setRunning(false);
		}
	}, [
		agentId,
		judgeModel,
		evaluatorIds,
		model,
		promptVariants,
		rows,
		selectedModels,
		suite,
		suiteName,
		target,
	]);

	const handleRun = useCallback(() => {
		run().catch(() => {
			// errors are surfaced via setError inside run().
		});
	}, [run]);

	return (
		<section className="flex flex-col gap-3 rounded-xl border p-4">
			<div className="flex items-center gap-2">
				<span className="font-medium text-base">Promptfoo suite</span>
				{suite ? (
					<Badge variant="secondary">{suiteVersions.length} versions</Badge>
				) : null}
				<span className="text-muted-foreground text-xs">
					{suiteLoading
						? "Loading durable suite…"
						: "Prompts, providers, tests, assertions, runs, and reviews"}
				</span>
			</div>

			<div className="flex flex-wrap items-end gap-2 rounded-lg bg-muted/20 p-3">
				<div className="flex min-w-56 flex-1 flex-col gap-1">
					<Label className="text-[11px]" htmlFor="promptfoo-suite-name">
						Suite name
					</Label>
					<Input
						className="h-8 text-xs"
						disabled={locked}
						id="promptfoo-suite-name"
						onChange={(event) => setSuiteName(event.target.value)}
						value={suiteName}
					/>
				</div>
				<div className="flex min-w-44 flex-col gap-1">
					<Label className="text-[11px]" htmlFor="promptfoo-save-label">
						Version label (optional)
					</Label>
					<Input
						className="h-8 text-xs"
						disabled={locked}
						id="promptfoo-save-label"
						onChange={(event) => setSaveLabel(event.target.value)}
						placeholder="Baseline, stricter rubric…"
						value={saveLabel}
					/>
				</div>
				<Button
					disabled={locked || suiteSaving || suiteLoading}
					loading={suiteSaving}
					onClick={() => saveSuite().catch(() => undefined)}
					size="sm"
				>
					Save suite
				</Button>
				{suiteVersions.length > 0 ? (
					<NativeSelect
						aria-label="Restore suite version"
						className="h-8 max-w-44 text-xs"
						disabled={locked}
						onChange={(event) => {
							if (event.target.value) {
								restoreSuiteVersion(event.target.value).catch(() => undefined);
							}
						}}
						value=""
					>
						<NativeSelectOption value="">Restore version…</NativeSelectOption>
						{suiteVersions.map((version) => (
							<NativeSelectOption key={version.id} value={version.id}>
								{version.label || new Date(version.createdAt).toLocaleString()}
							</NativeSelectOption>
						))}
					</NativeSelect>
				) : null}
				<label className="inline-flex cursor-pointer items-center">
					<span className="sr-only">Import Promptfoo config</span>
					<Input
						accept=".csv,.json,.jsonl,.md,.txt,.yaml,.yml,.j2"
						className="hidden"
						disabled={locked}
						onChange={(event) => importFile(event).catch(() => undefined)}
						type="file"
					/>
					<span className="rounded-md border px-2 py-1.5 text-xs hover:bg-muted">
						Import
					</span>
				</label>
				<NativeSelect
					aria-label="Export format"
					className="h-8 w-24 text-xs"
					onChange={(event) =>
						setExportFormat(event.target.value as typeof exportFormat)
					}
					value={exportFormat}
				>
					<NativeSelectOption value="yaml">YAML</NativeSelectOption>
					<NativeSelectOption value="json">JSON</NativeSelectOption>
					<NativeSelectOption value="jsonl">JSONL</NativeSelectOption>
					<NativeSelectOption value="csv">CSV</NativeSelectOption>
				</NativeSelect>
				<Button
					onClick={() => exportConfig(exportFormat)}
					size="sm"
					variant="outline"
				>
					Export
				</Button>
			</div>

			{suiteError ? (
				<p className="text-destructive text-xs">{suiteError}</p>
			) : null}

			<PromptVariantsEditor
				locked={locked}
				onAdd={addVariant}
				onRemove={removeVariant}
				onUpdate={updateVariant}
				variants={variants}
			/>

			{/* Test-case table */}
			<TestCaseTable
				onAddRow={addRow}
				onRemoveRow={removeRow}
				onUpdateRow={updateRow}
				rows={rows}
			/>

			{/* Model + judge inputs */}
			<ModelControls
				extraModels={extraModels}
				judgeModel={judgeModel}
				newModel={newModel}
				onAddModel={addExtraModel}
				onJudgeChange={setJudgeModel}
				onNewModelChange={setNewModel}
				onRemoveModel={removeExtraModel}
				primaryModel={model}
			/>
			<div className="flex flex-col gap-1 rounded-lg bg-muted/20 p-3">
				<Label className="text-[11px]" htmlFor="promptfoo-evaluators">
					Registry evaluators (optional, comma-separated)
				</Label>
				<Input
					className="h-7 text-xs"
					id="promptfoo-evaluators"
					onChange={(event) =>
						setEvaluatorIds(
							event.target.value
								.split(",")
								.map((id) => id.trim())
								.filter(Boolean)
						)
					}
					placeholder="assertions, exact_match, pii_detector…"
					value={evaluatorIds.join(", ")}
				/>
				<p className="text-[10px] text-muted-foreground">
					Uses the shared Gateway evaluator catalog in addition to inline
					assertions.
				</p>
			</div>

			{/* Run controls */}
			<div className="flex flex-wrap items-center gap-2">
				<Button
					disabled={runDisabled}
					loading={running}
					onClick={handleRun}
					size="sm"
				>
					<HugeiconsIcon className="size-3" icon={PlayIcon} />
					{running ? "Running…" : "Run test cases"}
				</Button>
				{running ? (
					<Button onClick={stop} size="sm" variant="ghost">
						<HugeiconsIcon className="size-3" icon={Square01Icon} />
						Stop
					</Button>
				) : null}
				<RunHint
					isAcp={isAcp}
					largeMatrix={largeMatrix}
					missingModel={!model.trim()}
				/>
			</div>

			{error ? <p className="text-destructive text-xs">{error}</p> : null}

			<PromptRunHistory
				onSelect={async (runId) => {
					if (!suite) {
						return;
					}
					try {
						const saved = await getPromptRun(target, suite.id, runId);
						const savedResults = saved.result.variants;
						if (Array.isArray(savedResults)) {
							setResults(savedResults as PromptVariantRun[]);
							setActiveRunId(runId);
						}
					} catch (loadError) {
						setError(
							loadError instanceof Error
								? loadError.message
								: "Failed to load run"
						);
					}
				}}
				runs={suiteRuns}
				selectedRunId={activeRunId}
			/>

			{/* Results matrix */}
			{results ? (
				<ResultsMatrix
					model={model}
					results={results}
					rows={rows}
					runId={activeRunId}
					suiteId={suite?.id ?? null}
					target={target}
				/>
			) : null}
		</section>
	);
}

function PromptVariantsEditor({
	locked,
	onAdd,
	onRemove,
	onUpdate,
	variants,
}: {
	locked: boolean;
	onAdd: () => void;
	onRemove: (id: string) => void;
	onUpdate: (id: string, patch: Partial<PromptVariantRow>) => void;
	variants: PromptVariantRow[];
}) {
	return (
		<div className="flex flex-col gap-2 rounded-lg bg-muted/20 p-3">
			<div className="flex items-center gap-2">
				<span className="font-medium text-xs">Prompt variants</span>
				<span className="text-[11px] text-muted-foreground">
					Run text or multi-turn prompt variants through the same test matrix.
				</span>
				<Button disabled={locked} onClick={onAdd} size="sm" variant="ghost">
					<HugeiconsIcon className="size-3" icon={Add01Icon} />
					Add variant
				</Button>
			</div>
			{variants.length === 0 ? (
				<p className="text-[11px] text-muted-foreground">
					The agent prompt above is the primary variant. Add another to compare
					prompt revisions side by side.
				</p>
			) : null}
			{variants.map((variant, index) => (
				<div
					className="flex flex-col gap-2 rounded-md border p-2"
					key={variant.id}
				>
					<div className="flex items-center gap-2">
						<Input
							className="h-7 max-w-48 text-xs"
							disabled={locked}
							onChange={(event) =>
								onUpdate(variant.id, { name: event.target.value })
							}
							value={variant.name || `Variant ${index + 1}`}
						/>
						<NativeSelect
							aria-label={`Prompt variant ${index + 1} type`}
							className="h-7 w-24 text-xs"
							disabled={locked}
							onChange={(event) =>
								onUpdate(variant.id, {
									messages:
										event.target.value === "chat" ? variant.messages : [],
									type: event.target.value as PromptVariantRow["type"],
								})
							}
							value={variant.type}
						>
							<NativeSelectOption value="text">Text</NativeSelectOption>
							<NativeSelectOption value="chat">Chat</NativeSelectOption>
						</NativeSelect>
						<Button
							aria-label={`Remove ${variant.name || `variant ${index + 1}`}`}
							disabled={locked}
							onClick={() => onRemove(variant.id)}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-3" icon={Delete02Icon} />
						</Button>
					</div>
					{variant.type === "chat" ? (
						<Textarea
							className="min-h-20 font-mono text-xs"
							disabled={locked}
							onChange={(event) => {
								try {
									const parsed: unknown = JSON.parse(event.target.value);
									if (!Array.isArray(parsed)) {
										return;
									}
									onUpdate(variant.id, {
										messages: parsed.filter(
											(message): message is EvalMessage =>
												typeof message === "object" &&
												message !== null &&
												["assistant", "system", "user"].includes(
													(message as { role?: unknown }).role as string
												) &&
												typeof (message as { content?: unknown }).content ===
													"string"
										),
									});
								} catch {
									// Keep the last valid message list until the JSON is complete.
								}
							}}
							placeholder='[{"role":"user","content":"Hello {{name}}"}]'
							value={JSON.stringify(variant.messages, null, 2)}
						/>
					) : (
						<Textarea
							className="min-h-20 font-mono text-xs"
							disabled={locked}
							onChange={(event) =>
								onUpdate(variant.id, { content: event.target.value })
							}
							placeholder="A second system prompt variant. {{vars}} are rendered per case."
							value={variant.content}
						/>
					)}
				</div>
			))}
		</div>
	);
}

function PromptRunHistory({
	onSelect,
	runs,
	selectedRunId,
}: {
	onSelect: (runId: string) => void;
	runs: PromptRunMeta[];
	selectedRunId: string | null;
}) {
	if (runs.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-muted/20 p-2">
			<span className="mr-1 font-medium text-[11px]">Runs</span>
			{runs.slice(0, 8).map((run) => (
				<Button
					className="h-7 text-[11px]"
					key={run.id}
					onClick={() => onSelect(run.id)}
					size="sm"
					variant={selectedRunId === run.id ? "secondary" : "ghost"}
				>
					{run.name}
				</Button>
			))}
		</div>
	);
}

// ── Test-case table ────────────────────────────────────────────────────────────

interface TestCaseTableProps {
	onAddRow: () => void;
	onRemoveRow: (id: string) => void;
	onUpdateRow: (id: string, patch: Partial<TestCaseRow>) => void;
	rows: TestCaseRow[];
}

function TestCaseTable({
	rows,
	onAddRow,
	onRemoveRow,
	onUpdateRow,
}: TestCaseTableProps) {
	return (
		<div className="flex flex-col gap-2">
			{rows.length === 0 ? (
				<p className="rounded-md border border-dashed p-3 text-center text-muted-foreground text-xs">
					No test cases. Add one to evaluate the draft prompt with assertions.
					With none, the gateway falls back to its built-in 3-case set.
				</p>
			) : null}
			{rows.map((row, i) => (
				<TestCaseRowEditor
					index={i}
					key={row.id}
					onRemove={onRemoveRow}
					onUpdate={onUpdateRow}
					row={row}
				/>
			))}
			<div>
				<Button onClick={onAddRow} size="sm" variant="ghost">
					<HugeiconsIcon className="size-3" icon={Add01Icon} />
					Add test case
				</Button>
			</div>
		</div>
	);
}

interface TestCaseRowEditorProps {
	index: number;
	onRemove: (id: string) => void;
	onUpdate: (id: string, patch: Partial<TestCaseRow>) => void;
	row: TestCaseRow;
}

function TestCaseRowEditor({
	row,
	index,
	onRemove,
	onUpdate,
}: TestCaseRowEditorProps) {
	// Var keys auto-suggested from the input + assertion text.
	const suggestedVars = useMemo(() => {
		const assertionBlob = row.assertions.map(assertionText).join("\n");
		return extractPlaceholders(`${row.input}\n${assertionBlob}`);
	}, [row.input, row.assertions]);

	const handleVarChange = useCallback(
		(name: string, val: string) => {
			onUpdate(row.id, { vars: { ...row.vars, [name]: parseVariable(val) } });
		},
		[onUpdate, row.id, row.vars]
	);

	const handleAddAssertion = useCallback(() => {
		onUpdate(row.id, {
			assertions: [...row.assertions, defaultAssertion("contains")],
		});
	}, [onUpdate, row.id, row.assertions]);

	const handleUpdateAssertion = useCallback(
		(idx: number, a: Assertion) => {
			const next = row.assertions.slice();
			next[idx] = a;
			onUpdate(row.id, { assertions: next });
		},
		[onUpdate, row.id, row.assertions]
	);

	const handleRemoveAssertion = useCallback(
		(idx: number) => {
			onUpdate(row.id, {
				assertions: row.assertions.filter((_, j) => j !== idx),
			});
		},
		[onUpdate, row.id, row.assertions]
	);

	return (
		<div className="flex flex-col gap-2 rounded-lg bg-muted/20 p-3">
			<div className="flex items-center gap-2">
				<span className="font-medium text-muted-foreground text-xs">
					Case {index + 1}
				</span>
				<Input
					autoComplete="off"
					className="h-7 max-w-48 text-xs"
					name={`test-case-name-${row.id}`}
					onChange={(e) => onUpdate(row.id, { name: e.target.value })}
					placeholder="Name (optional)"
					value={row.name}
				/>
				<Button
					aria-label={`Remove test case ${index + 1}`}
					className="ml-auto"
					onClick={() => onRemove(row.id)}
					size="icon-sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3" icon={Delete02Icon} />
				</Button>
			</div>

			<div className="flex flex-col gap-1">
				<Label className="text-xs" htmlFor={`test-input-${row.id}`}>
					User message
				</Label>
				<Textarea
					className="min-h-16 font-mono text-xs"
					id={`test-input-${row.id}`}
					name={`test-input-${row.id}`}
					onChange={(e) => onUpdate(row.id, { input: e.target.value })}
					placeholder="The user message. {{vars}} allowed."
					value={row.input}
				/>
			</div>

			{suggestedVars.length > 0 ? (
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
					{suggestedVars.map((name) => (
						<div className="flex flex-col gap-1" key={name}>
							<Label className="text-[11px]">{name}</Label>
							<Input
								autoComplete="off"
								className="h-7 text-xs"
								name={`test-variable-${row.id}-${name}`}
								onChange={(e) => handleVarChange(name, e.target.value)}
								placeholder={`Value for {{${name}}}`}
								value={displayVariable(row.vars[name])}
							/>
						</div>
					))}
				</div>
			) : null}

			<div className="flex flex-col gap-1">
				<Label className="text-xs" htmlFor={`test-messages-${row.id}`}>
					Chat messages (optional JSON)
				</Label>
				<Textarea
					className="min-h-16 font-mono text-xs"
					id={`test-messages-${row.id}`}
					onChange={(event) => {
						try {
							const parsed: unknown = JSON.parse(event.target.value);
							if (!Array.isArray(parsed)) {
								return;
							}
							onUpdate(row.id, {
								messages: parsed.filter(
									(message): message is EvalMessage =>
										typeof message === "object" &&
										message !== null &&
										["assistant", "system", "user"].includes(
											(message as { role?: unknown }).role as string
										) &&
										typeof (message as { content?: unknown }).content ===
											"string"
								),
							});
						} catch {
							// Keep the last valid list while the user edits JSON.
						}
					}}
					placeholder='[{"role":"user","content":"Question for {{name}}"}]'
					value={JSON.stringify(row.messages ?? [], null, 2)}
				/>
			</div>

			<div className="flex flex-col gap-1">
				<Label className="text-xs" htmlFor={`test-expected-${row.id}`}>
					Expected (optional substring)
				</Label>
				<Input
					className="h-7 text-xs"
					id={`test-expected-${row.id}`}
					name={`test-expected-${row.id}`}
					onChange={(e) => onUpdate(row.id, { expected: e.target.value })}
					placeholder="Substring the response should contain"
					value={row.expected}
				/>
			</div>

			<div className="flex flex-col gap-1">
				<Label className="text-xs" htmlFor={`test-threshold-${row.id}`}>
					Assertion threshold (optional)
				</Label>
				<Input
					className="h-7 text-xs"
					id={`test-threshold-${row.id}`}
					inputMode="decimal"
					max="1"
					min="0"
					name={`test-threshold-${row.id}`}
					onChange={(e) => onUpdate(row.id, { threshold: e.target.value })}
					placeholder="1.0 means every assertion must pass"
					step="0.05"
					type="number"
					value={row.threshold}
				/>
			</div>

			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
				<div className="flex flex-col gap-1">
					<Label className="text-[11px]" htmlFor={`test-providers-${row.id}`}>
						Providers (optional, comma-separated)
					</Label>
					<Input
						className="h-7 text-xs"
						id={`test-providers-${row.id}`}
						onChange={(event) =>
							onUpdate(row.id, {
								providers: event.target.value
									.split(",")
									.map((provider) => provider.trim())
									.filter(Boolean),
							})
						}
						placeholder="openai:gpt-4o, anthropic:claude…"
						value={row.providers.join(", ")}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label className="text-[11px]" htmlFor={`test-metadata-${row.id}`}>
						Metadata JSON
					</Label>
					<Input
						className="h-7 font-mono text-xs"
						id={`test-metadata-${row.id}`}
						onChange={(event) => {
							try {
								const parsed: unknown = JSON.parse(event.target.value);
								if (isRecord(parsed)) {
									onUpdate(row.id, { metadata: parsed });
								}
							} catch {
								// Keep the last valid object while editing.
							}
						}}
						placeholder='{"team":"support"}'
						value={JSON.stringify(row.metadata)}
					/>
				</div>
			</div>

			<div className="flex flex-col gap-2">
				<Label className="text-xs">Assertions</Label>
				{row.assertions.map((a, idx) => (
					<AssertionEditor
						assertion={a}
						// biome-ignore lint/suspicious/noArrayIndexKey: assertions are positional within a row and have no stable id
						key={`assertion-${idx}`}
						onRemove={() => handleRemoveAssertion(idx)}
						onUpdate={(next) => handleUpdateAssertion(idx, next)}
					/>
				))}
				<div>
					<Button onClick={handleAddAssertion} size="sm" variant="ghost">
						<HugeiconsIcon className="size-3" icon={Add01Icon} />
						Add assertion
					</Button>
				</div>
			</div>
		</div>
	);
}

interface AssertionEditorProps {
	assertion: Assertion;
	onRemove: () => void;
	onUpdate: (a: Assertion) => void;
}

function AssertionEditor({
	assertion,
	onUpdate,
	onRemove,
}: AssertionEditorProps) {
	const needsText = ![
		"json_valid",
		"is_json",
		"is_html",
		"is_xml",
		"is_sql",
		"is_refusal",
	].includes(assertion.kind);
	const isJudge = [
		"llm_judge",
		"llm_rubric",
		"factuality",
		"context_faithfulness",
		"answer_relevance",
	].includes(assertion.kind);

	const handleKindChange = useCallback(
		(kind: AssertionKind) => {
			// Preserve the existing text payload where the new kind supports one.
			const text = assertionText(assertion);
			const base = defaultAssertion(kind);
			onUpdate(
				withAssertionText(
					assertion.options ? { ...base, options: assertion.options } : base,
					text
				)
			);
		},
		[assertion, onUpdate]
	);

	const handleTextChange = useCallback(
		(text: string) => {
			onUpdate(withAssertionText(assertion, text));
		},
		[assertion, onUpdate]
	);

	const updateOptions = useCallback(
		(patch: Partial<AssertionOptions>) => {
			onUpdate({
				...assertion,
				options: { ...assertion.options, ...patch },
			} as Assertion);
		},
		[assertion, onUpdate]
	);

	let placeholder = "Value";
	if (isJudge) {
		placeholder = "Rubric: what the answer must satisfy";
	} else if (assertion.kind === "regex") {
		placeholder = "Regular expression";
	} else if (
		["javascript", "python", "ruby", "webhook"].includes(assertion.kind)
	) {
		placeholder = "Runtime expression or endpoint configuration";
	} else if (
		assertion.kind === "contains_any" ||
		assertion.kind === "contains_all" ||
		assertion.kind === "icontains_any" ||
		assertion.kind === "icontains_all"
	) {
		placeholder = "Comma-separated values";
	}

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-2">
				<NativeSelect
					aria-label="Assertion type"
					className="h-7 w-36 text-xs"
					onChange={(e) => handleKindChange(e.target.value as AssertionKind)}
					value={assertion.kind}
				>
					{ASSERTION_KINDS.map((k) => (
						<NativeSelectOption key={k} value={k}>
							{ASSERTION_LABELS[k]}
						</NativeSelectOption>
					))}
				</NativeSelect>
				{needsText ? (
					<Input
						aria-label="Assertion value"
						className="h-7 flex-1 text-xs"
						onChange={(e) => handleTextChange(e.target.value)}
						placeholder={placeholder}
						value={assertionText(assertion)}
					/>
				) : (
					<span className="flex-1 text-muted-foreground text-xs">
						Passes when the response is valid JSON.
					</span>
				)}
				<Button
					aria-label="Remove assertion"
					onClick={onRemove}
					size="icon-sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3" icon={Cancel01Icon} />
				</Button>
			</div>
			<div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
				<Input
					aria-label="Assertion threshold"
					className="h-6 text-[10px]"
					inputMode="decimal"
					max="1"
					min="0"
					onChange={(event) =>
						updateOptions({ threshold: parseThreshold(event.target.value) })
					}
					placeholder="Threshold"
					step="0.05"
					type="number"
					value={assertion.options?.threshold ?? ""}
				/>
				<Input
					aria-label="Assertion weight"
					className="h-6 text-[10px]"
					inputMode="decimal"
					min="0"
					onChange={(event) => {
						const parsed = Number.parseFloat(event.target.value);
						updateOptions({
							weight: Number.isFinite(parsed) ? parsed : undefined,
						});
					}}
					placeholder="Weight"
					step="0.1"
					type="number"
					value={assertion.options?.weight ?? ""}
				/>
				<Input
					aria-label="Assertion provider"
					className="h-6 text-[10px]"
					onChange={(event) =>
						updateOptions({ provider: event.target.value || undefined })
					}
					placeholder="Judge model/provider"
					value={assertion.options?.provider ?? ""}
				/>
				<Input
					aria-label="Assertion transform"
					className="h-6 text-[10px]"
					onChange={(event) =>
						updateOptions({ transform: event.target.value || undefined })
					}
					placeholder="Transform (exported)"
					value={assertion.options?.transform ?? ""}
				/>
			</div>
		</div>
	);
}

// ── Model controls ─────────────────────────────────────────────────────────────

interface ModelControlsProps {
	extraModels: string[];
	judgeModel: string;
	newModel: string;
	onAddModel: () => void;
	onJudgeChange: (v: string) => void;
	onNewModelChange: (v: string) => void;
	onRemoveModel: (m: string) => void;
	primaryModel: string;
}

function ModelControls({
	primaryModel,
	extraModels,
	newModel,
	judgeModel,
	onNewModelChange,
	onAddModel,
	onRemoveModel,
	onJudgeChange,
}: ModelControlsProps) {
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Enter") {
				e.preventDefault();
				onAddModel();
			}
		},
		[onAddModel]
	);

	return (
		<div className="flex flex-col gap-2 rounded-lg bg-muted/20 p-3">
			<div className="flex flex-wrap items-center gap-1.5">
				<span className="font-medium text-xs">Models</span>
				<Badge variant="secondary">{primaryModel || "no model"}</Badge>
				{extraModels.map((m) => (
					<Badge className="gap-1 pr-1" key={m} variant="outline">
						{m}
						<Button
							aria-label={`Remove model ${m}`}
							className="size-4"
							onClick={() => onRemoveModel(m)}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-2.5" icon={Cancel01Icon} />
						</Button>
					</Badge>
				))}
			</div>
			<div className="flex flex-wrap items-end gap-2">
				<div className="flex flex-col gap-1">
					<Label className="text-[11px]" htmlFor="ps-add-model">
						Add model to compare
					</Label>
					<div className="flex items-center gap-1">
						<Input
							className="h-7 w-48 text-xs"
							id="ps-add-model"
							onChange={(e) => onNewModelChange(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="e.g. claude-3-5-haiku"
							value={newModel}
						/>
						<Button
							aria-label="Add model"
							onClick={onAddModel}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-3" icon={Add01Icon} />
						</Button>
					</div>
				</div>
				<div className="flex flex-col gap-1">
					<Label className="text-[11px]" htmlFor="ps-judge-model">
						Judge model (optional)
					</Label>
					<Input
						className="h-7 w-48 text-xs"
						id="ps-judge-model"
						onChange={(e) => onJudgeChange(e.target.value)}
						placeholder="defaults to the first model"
						value={judgeModel}
					/>
				</div>
			</div>
		</div>
	);
}

function RunHint({
	isAcp,
	missingModel,
	largeMatrix,
}: {
	isAcp: boolean;
	missingModel: boolean;
	largeMatrix: boolean;
}) {
	if (missingModel) {
		return (
			<span className="text-muted-foreground text-xs">
				No model bound — wire the agent's model to run evals.
			</span>
		);
	}
	if (isAcp) {
		return (
			<span className="text-muted-foreground text-xs">
				ACP agents bypass the gateway, so gateway evals do not apply.
			</span>
		);
	}
	if (largeMatrix) {
		return (
			<span className="text-warning text-xs dark:text-warning">
				Large matrix — this may be slow and could hit a 120s timeout.
			</span>
		);
	}
	return null;
}

// ── Results matrix ─────────────────────────────────────────────────────────────

interface ResultsMatrixProps {
	model: string;
	results: PromptVariantRun[];
	rows: TestCaseRow[];
	runId: string | null;
	suiteId: string | null;
	target: ApiTarget;
}

function resultCsv(
	results: PromptVariantRun[],
	model: string,
	rows: TestCaseRow[]
): string {
	const cell = (value: unknown): string => {
		const text =
			typeof value === "string" ? value : JSON.stringify(value ?? "");
		return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
	};
	const output = [
		"prompt,model,case,overall,assertion_score,assertions_pass,response",
	];
	for (const promptResult of results) {
		const models = promptResult.result.models ?? [
			{
				model,
				cases: promptResult.result.cases,
				aggregate: promptResult.result.aggregate,
			},
		];
		for (const entry of models) {
			entry.cases.forEach((score, index) => {
				output.push(
					[
						promptResult.promptName,
						entry.model,
						rows[index]?.name || `Case ${index + 1}`,
						score.overall,
						score.assertion_score,
						score.assertions_pass,
						score.response_text,
					]
						.map(cell)
						.join(",")
				);
			});
		}
	}
	return output.join("\n");
}

function ResultsMatrix({
	model,
	results,
	rows,
	runId,
	suiteId,
	target,
}: ResultsMatrixProps) {
	const downloadResults = (format: "csv" | "json") => {
		const text =
			format === "csv"
				? resultCsv(results, model, rows)
				: JSON.stringify(results, null, 2);
		const link = document.createElement("a");
		link.href = URL.createObjectURL(
			new Blob([text], {
				type: format === "csv" ? "text/csv" : "application/json",
			})
		);
		link.download = `promptfoo-results.${format}`;
		link.click();
		URL.revokeObjectURL(link.href);
	};
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-2">
				<span className="font-medium text-xs">Results</span>
				<span className="text-[10px] text-muted-foreground">
					Download a reviewable report or reopen this run from history.
				</span>
				<div className="ml-auto flex items-center gap-1">
					<Button
						onClick={() => downloadResults("json")}
						size="sm"
						variant="ghost"
					>
						JSON
					</Button>
					<Button
						onClick={() => downloadResults("csv")}
						size="sm"
						variant="ghost"
					>
						CSV
					</Button>
				</div>
			</div>
			{results.map((promptResult) => {
				// Back-compat read path: single-model responses have no `models` key.
				const models: ModelEvalResult[] = promptResult.result.models ?? [
					{
						model,
						cases: promptResult.result.cases,
						aggregate: promptResult.result.aggregate,
					},
				];
				const caseCount = Math.max(
					rows.length,
					...models.map((entry) => entry.cases.length)
				);
				const caseIndices = Array.from({ length: caseCount }, (_, i) => i);
				return (
					<div
						className="flex flex-col gap-3 rounded-lg border p-3"
						key={promptResult.promptId}
					>
						<div className="flex items-center gap-2">
							<span className="font-medium text-xs">
								{promptResult.promptName}
							</span>
							<Badge variant="outline">
								{models.length} model{models.length === 1 ? "" : "s"}
							</Badge>
						</div>
						<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
							{models.map((entry) => (
								<ModelStatCard key={entry.model} result={entry} />
							))}
						</div>
						<div className="overflow-auto rounded-lg border">
							<table className="w-full text-left text-xs">
								<thead className="bg-muted/50 text-muted-foreground">
									<tr>
										<th className="px-2 py-1.5 font-medium">Case</th>
										{models.map((entry) => (
											<th className="px-2 py-1.5 font-medium" key={entry.model}>
												{entry.model}
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{caseIndices.map((idx) => (
										<tr className="border-t align-top" key={`case-${idx}`}>
											<td className="max-w-40 px-2 py-1.5">
												<CaseLabel
													fallback={models[0]?.cases[idx]?.prompt}
													row={rows[idx]}
												/>
											</td>
											{models.map((entry) => (
												<td
													className="min-w-48 max-w-72 px-2 py-1.5"
													key={entry.model}
												>
													<MatrixCell
														resultKey={`${promptResult.promptId}:${entry.model}:${idx}`}
														runId={runId}
														score={entry.cases[idx]}
														suiteId={suiteId}
														target={target}
													/>
												</td>
											))}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</div>
				);
			})}
		</div>
	);
}

function CaseLabel({
	row,
	fallback,
}: {
	row: TestCaseRow | undefined;
	fallback: string | undefined;
}) {
	let label = fallback ?? "—";
	if (row) {
		label = row.name.trim() || row.input || fallback || "—";
	}
	return <span className="line-clamp-3 break-words">{label}</span>;
}

function ModelStatCard({ result }: { result: ModelEvalResult }) {
	const agg = result.aggregate;
	const total = result.cases.length;
	const passing = result.cases.filter((c) => c.assertions_pass).length;
	const assertionRate = total > 0 ? passing / total : 1;
	return (
		<div className="flex flex-col gap-1 rounded-lg bg-muted/30 p-2">
			<span className="font-medium text-xs">{result.model}</span>
			<div className="grid grid-cols-3 gap-1">
				<StatCell
					label="Overall"
					tone={scoreTone(agg.mean_overall)}
					value={pct(agg.mean_overall)}
				/>
				<StatCell label="Policy" value={pct(agg.policy_pass_rate)} />
				<StatCell
					label="Assert"
					tone={scoreTone(assertionRate)}
					value={pct(assertionRate)}
				/>
			</div>
		</div>
	);
}

function StatCell({
	label,
	value,
	tone,
}: {
	label: string;
	value: string;
	tone?: string;
}) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-[9px] text-muted-foreground uppercase tracking-wide">
				{label}
			</span>
			<span className={`font-medium text-xs ${tone ?? ""}`}>{value}</span>
		</div>
	);
}

function MatrixCell({
	resultKey,
	runId,
	score,
	suiteId,
	target,
}: {
	resultKey: string;
	runId: string | null;
	score: EvalCaseScore | undefined;
	suiteId: string | null;
	target: ApiTarget;
}) {
	const [reviewSaving, setReviewSaving] = useState(false);
	const [reviewed, setReviewed] = useState<boolean | null>(null);
	const [reviewComment, setReviewComment] = useState("");
	const [reviewHighlighted, setReviewHighlighted] = useState(false);
	if (!score) {
		return <span className="text-muted-foreground">—</span>;
	}
	const review = async (
		pass: boolean,
		options: { highlighted?: boolean } = {}
	) => {
		if (!(runId && suiteId)) {
			return;
		}
		setReviewSaving(true);
		try {
			await savePromptReview(target, suiteId, runId, {
				comment: reviewComment.trim() || undefined,
				highlighted: options.highlighted ?? reviewHighlighted,
				pass,
				resultKey,
				score: score.overall,
			});
			setReviewed(pass);
		} finally {
			setReviewSaving(false);
		}
	};
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex flex-wrap items-center gap-1">
				<Badge
					className={`text-[10px] ${score.assertions_pass ? "" : "border-destructive text-destructive"}`}
					variant={score.assertions_pass ? "secondary" : "outline"}
				>
					{score.assertions_pass ? "pass" : "fail"}
				</Badge>
				<span className={`font-medium ${scoreTone(score.overall)}`}>
					{pct(score.overall)}
				</span>
			</div>
			<AssertionChips assertions={score.assertions} />
			{score.evaluators && score.evaluators.length > 0 ? (
				<div className="flex flex-wrap gap-1">
					{score.evaluators.map((evaluator) => (
						<span
							className={`rounded px-1 py-0.5 text-[10px] ${evaluator.pass ? "bg-success/15 text-success dark:text-success" : "bg-warning/15 text-warning dark:text-warning"}`}
							key={evaluator.id}
						>
							{evaluator.id}:{" "}
							{evaluator.executed ? pct(evaluator.score) : "skipped"}
						</span>
					))}
				</div>
			) : null}
			<p className="line-clamp-4 whitespace-pre-wrap break-words text-muted-foreground">
				{score.response_text}
			</p>
			{runId && suiteId ? (
				<div className="flex items-center gap-1">
					<span className="mr-1 text-[10px] text-muted-foreground">Review</span>
					<Button
						className="h-6 px-1.5 text-[10px]"
						disabled={reviewSaving}
						onClick={() => review(true).catch(() => undefined)}
						size="sm"
						variant={reviewed === true ? "secondary" : "ghost"}
					>
						Pass
					</Button>
					<Button
						className="h-6 px-1.5 text-[10px]"
						disabled={reviewSaving}
						onClick={() => review(false).catch(() => undefined)}
						size="sm"
						variant={reviewed === false ? "destructive" : "ghost"}
					>
						Fail
					</Button>
					<Button
						className="h-6 px-1.5 text-[10px]"
						disabled={reviewSaving}
						onClick={() => {
							const next = !reviewHighlighted;
							setReviewHighlighted(next);
							review(reviewed ?? score.assertions_pass, {
								highlighted: next,
							}).catch(() => undefined);
						}}
						size="sm"
						variant={reviewHighlighted ? "secondary" : "ghost"}
					>
						{reviewHighlighted ? "Highlighted" : "Highlight"}
					</Button>
					<Input
						aria-label="Human review comment"
						className="h-6 text-[10px]"
						disabled={reviewSaving}
						onChange={(event) => setReviewComment(event.target.value)}
						placeholder="Add a review comment…"
						value={reviewComment}
					/>
					<Button
						className="h-6 self-start px-1.5 text-[10px]"
						disabled={reviewSaving || !reviewComment.trim()}
						onClick={() =>
							review(reviewed ?? score.assertions_pass).catch(() => undefined)
						}
						size="sm"
						variant="ghost"
					>
						Save comment
					</Button>
				</div>
			) : null}
		</div>
	);
}

function AssertionChips({ assertions }: { assertions: AssertionResult[] }) {
	if (assertions.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap gap-1">
			{assertions.map((a, i) => {
				const className = `rounded px-1 py-0.5 text-[10px] ${a.pass ? "bg-success/15 text-success dark:text-success" : "bg-destructive/15 text-destructive"}`;
				return a.detail ? (
					<Tooltip
						// biome-ignore lint/suspicious/noArrayIndexKey: assertion results are positional and have no stable id
						key={`${a.kind}-${i}`}
					>
						<TooltipTrigger
							render={<span className={className}>{a.kind}</span>}
						/>
						<TooltipContent>{a.detail}</TooltipContent>
					</Tooltip>
				) : (
					<span
						className={className}
						// biome-ignore lint/suspicious/noArrayIndexKey: assertion results are positional and have no stable id
						key={`${a.kind}-${i}`}
					>
						{a.kind}
					</span>
				);
			})}
		</div>
	);
}

// ── Preview panel ──────────────────────────────────────────────────────────────

interface PreviewPanelProps {
	agentId: string;
	convId: string;
	prompt: string;
	target: ApiTarget;
}

function PreviewPanel({ prompt, agentId, target, convId }: PreviewPanelProps) {
	// The preview sends the rendered draft prompt framed as a user message so the
	// agent can echo it back or reflect on it. This is the only approach available
	// without a system_prompt override field in ChatStreamRequest.
	const previewMessage = `[PROMPT PREVIEW]\n\nDraft system prompt:\n\`\`\`\n${prompt}\n\`\`\`\n\nRespond as if this were your system prompt and confirm you understand your role.`;

	const { messages, setMessages, status, error, stop } = useChat({
		id: convId,
		transport: new DefaultChatTransport({
			api: chatStreamUrl(target),
			// Developer-mode turn timing; a plain `fetch` when metrics are off.
			fetch: instrumentedFetch,
			headers: (): Record<string, string> => chatHeaders(target),
			body: () => ({
				agent_id: agentId,
				response_mode: "developer",
				conversation_id: convId,
				enable_long_term: false,
			}),
		}),
	});
	useEffect(() => {
		if (messages.length > 0) {
			return;
		}
		setMessages([
			{
				id: "preview-user",
				role: "user",
				parts: [{ type: "text", text: previewMessage }],
			},
		]);
	}, [messages.length, previewMessage, setMessages]);

	const isStreaming = status === "streaming" || status === "submitted";

	const assistantMessages = messages.filter((m) => m.role === "assistant");
	const lastAssistant = assistantMessages.at(-1);

	const responseText =
		lastAssistant?.parts
			.filter((p) => p.type === "text")
			.map((p) => (p as { type: "text"; text: string }).text)
			.join("") ?? "";

	return (
		<div className="flex flex-col gap-3 rounded-lg bg-card p-4">
			<div className="flex items-center gap-2">
				<span className="font-medium text-sm">Preview response</span>
				{isStreaming ? (
					<Badge className="ml-auto animate-pulse" variant="secondary">
						Streaming…
					</Badge>
				) : null}
				{isStreaming ? (
					<Button onClick={stop} size="icon-sm" variant="ghost">
						<HugeiconsIcon className="size-3" icon={Square01Icon} />
					</Button>
				) : null}
			</div>

			{error ? (
				<p className="text-destructive text-xs">{error.message}</p>
			) : null}

			{responseText ? (
				<div className="whitespace-pre-wrap rounded bg-muted/40 p-3 font-mono text-xs leading-relaxed">
					{responseText}
				</div>
			) : (
				<PreviewPlaceholder streaming={isStreaming} />
			)}
		</div>
	);
}

function PreviewPlaceholder({ streaming }: { streaming: boolean }) {
	if (streaming) {
		return (
			<p className="text-muted-foreground text-xs">Waiting for response…</p>
		);
	}
	return <p className="text-muted-foreground text-xs">No response yet.</p>;
}
