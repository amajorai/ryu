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
	ArrowDown01Icon,
	ArrowUp01Icon,
	Cancel01Icon,
	Copy01Icon,
	Delete02Icon,
	Edit02Icon,
	LockedIcon,
	PlayIcon,
	Square01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Markdown } from "@ryu/blocks/desktop/agent-elements/markdown.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { DefaultChatTransport } from "ai";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { MarkdownEditor } from "@/src/components/editor/MarkdownEditor.tsx";
import { PromptLibrary } from "@/src/components/PromptLibrary.tsx";
import { VersionHistory } from "@/src/components/versioning/VersionHistory.tsx";
import { toastActionError } from "@/src/lib/action-error.ts";
import {
	createAgentPromptVersion,
	getAgentPromptVersion,
	listAgentPromptVersions,
	restoreAgentPromptVersion,
} from "@/src/lib/api/agents.ts";
import { cancelChat, chatHeaders, chatStreamUrl } from "@/src/lib/api/chat.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type Assertion,
	type AssertionOptions,
	type AssertionResult,
	type CodeEvaluatorSpec,
	type EvalCaseScore,
	type EvalDatasetCase,
	type EvalMessage,
	type ModelEvalResult,
	runGatewayEvals,
} from "@/src/lib/api/gateway.ts";
import {
	createPromptSuite,
	deletePromptRun,
	duplicatePromptRun,
	getPromptRun,
	listPromptReviews,
	listPromptRuns,
	listPromptSuites,
	listPromptSuiteVersions,
	type PromptReview,
	type PromptRunMeta,
	type PromptSuiteRecord,
	type PromptSuiteVersionMeta,
	renamePromptRun,
	restorePromptSuiteVersion,
	savePromptReview,
	savePromptRun,
	updatePromptSuite,
} from "@/src/lib/api/prompt-suites.ts";
import { instrumentedFetch } from "@/src/lib/dev-metrics.ts";
import {
	ASSERTION_KINDS,
	ASSERTION_LABELS,
	type AssertionKind,
	assertionKindSchema,
	assertionText,
	defaultAssertion,
	gatewayAssertion,
	isBoolean,
	isNumber,
	isRecord,
	isString,
	linkedPromptRunId,
	loadTestSuite,
	newTestCaseRow,
	type PromptVariantRun,
	parseCodeEvaluators,
	parseEvalMessages,
	parseRunTags,
	parseThreshold,
	persistTestSuite,
	promptVariantRunsSchema,
	resultFilterSchema,
	type TestCaseRow,
	withAssertionText,
} from "@/src/lib/prompt-studio.ts";
import {
	normalizePromptfooConfig,
	type PromptfooConfig,
	type PromptfooDocument,
	type PromptfooPrompt,
	type PromptfooRelatedFiles,
	type PromptfooTest,
	type PromptfooValue,
	parsePromptfooDocument,
	parsePromptfooFile,
	parsePromptfooValue,
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

function normalizePromptPlaceholders(prompt: string): string {
	// Plate's Markdown serializer escapes opening braces. Preserve Prompt Studio's
	// documented `{{variable}}` syntax when the prompt is edited in the rich editor.
	return prompt.replace(/\\+\{\\+\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/gu, "{{$1}}");
}

function escapePromptPlaceholdersForEditor(prompt: string): string {
	// Plate's Markdown parser interprets raw `{{name}}` as an expression instead
	// of literal prompt text. Escaping the openers keeps placeholders visible;
	// normalizePromptPlaceholders removes those escapes on the next edit.
	return prompt.replace(
		/(?<!\\)\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/gu,
		String.raw`\{\{$1}}`
	);
}

function hasPromptContent(prompt: string): boolean {
	return prompt.replaceAll("\u200B", "").trim().length > 0;
}

function renderPrompt(prompt: string, vars: Record<string, string>): string {
	return prompt.replace(
		PLACEHOLDER_RE,
		(_, name: string) => vars[name] ?? `{{${name}}}`
	);
}

function displayVariable(value: PromptfooValue): string {
	if (isString(value)) {
		return value;
	}
	if (value === undefined) {
		return "";
	}
	return JSON.stringify(value);
}

function parseVariable(value: string): PromptfooValue {
	const trimmed = value.trim();
	if (!trimmed) {
		return "";
	}
	try {
		return parsePromptfooValue(JSON.parse(trimmed));
	} catch {
		return value;
	}
}

function pct(value: number): string {
	return `${Math.round(value * 100)}%`;
}

function scoreTone(score: number): string {
	if (score >= 0.75) {
		return "text-status-success dark:text-status-success";
	}
	if (score >= 0.5) {
		return "text-status-warning dark:text-status-warning";
	}
	return "text-status-destructive";
}

function formatMicroUsd(value: number | null | undefined): string {
	return value === null || value === undefined
		? "unknown"
		: `$${(value / 1_000_000).toFixed(4)}`;
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
	const [editorRevision, setEditorRevision] = useState(0);
	const lastEditorValueRef = useRef(value);
	// Variable values entered by the user for the preview substitution.
	const [varValues, setVarValues] = useState<Record<string, string>>({});
	// Whether the preview panel is open.
	const [previewOpen, setPreviewOpen] = useState(false);
	// A stable, ephemeral conversation id per preview session so Core doesn't
	// accumulate junk conversation rows across many preview runs.
	const previewConvIdRef = useRef<string>(`preview-${crypto.randomUUID()}`);

	const placeholders = useMemo(() => extractPlaceholders(value), [value]);
	useEffect(() => {
		if (lastEditorValueRef.current === value) {
			return;
		}
		lastEditorValueRef.current = value;
		setEditorRevision((revision) => revision + 1);
	}, [value]);
	const promptVersionScope = useMemo(
		() => ({}),
		[agentId, target.url, target.token, target.userJwt]
	);
	const activePromptVersionScope = useRef(promptVersionScope);
	activePromptVersionScope.current = promptVersionScope;
	const promptVersionMounted = useRef(true);
	useEffect(() => {
		promptVersionMounted.current = true;
		return () => {
			promptVersionMounted.current = false;
		};
	}, []);
	const promptVersionSource = useMemo(() => {
		if (!agentId) {
			return null;
		}
		return {
			scope: promptVersionScope,
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
				if (
					!promptVersionMounted.current ||
					activePromptVersionScope.current !== promptVersionScope
				) {
					return;
				}
				onChange(restored);
			},
			snapshot: () => createAgentPromptVersion(target, agentId, value),
		};
	}, [agentId, onChange, target, value, promptVersionScope]);

	// Reset unknown var values when the placeholder set changes — avoid stale keys
	// polluting the rendered prompt.
	// varValues is read but deliberately excluded to avoid an update loop; only the placeholder set drives the reset.
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
				<Badge className="ml-1" size="compact" variant="secondary">
					v{version}
				</Badge>
				<div className="ml-auto flex items-center gap-2">
					<PromptLibrary
						currentPrompt={value}
						locked={locked}
						onUsePrompt={onChange}
						target={target}
					/>
					{promptVersionSource ? (
						<VersionHistory
							currentValue={value}
							disabled={locked}
							source={promptVersionSource}
						/>
					) : null}
					{locked ? (
						<Badge variant="secondary">
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
							initialMarkdown={escapePromptPlaceholdersForEditor(value)}
							key={`${agentId ?? "new"}:${editorRevision}`}
							onChangeMarkdown={(markdown) => {
								const nextValue = normalizePromptPlaceholders(markdown);
								lastEditorValueRef.current = nextValue;
								onChange(nextValue);
							}}
						/>
					</div>
				)}
				<p className="text-muted-foreground text-xs">
					Use{" "}
					<code className="type-caption rounded bg-muted px-1 font-mono">
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
								<Label htmlFor={`var-${name}`} size="compact">
									{name}
								</Label>
								<Input
									autoComplete="off"
									id={`var-${name}`}
									name={`preview-variable-${name}`}
									onChange={(e) => handleVarChange(name, e.target.value)}
									placeholder={`Value for {{${name}}}`}
									size="compact"
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
					disabled={!(agentId && hasPromptContent(value))}
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

interface PendingPromptfooImport {
	config: PromptfooConfig;
	filename: string;
	warnings: string[];
}

function promptfooImportWarnings(config: PromptfooConfig): string[] {
	const warnings: string[] = [];
	if (Array.isArray(config.functions) && config.functions.length > 0) {
		warnings.push(
			"Dynamic functions are retained as configuration but are not executed during import; use an explicit Core-sandbox code evaluator to run user code."
		);
	}
	return warnings;
}

function promptfooConfigExtras(config: PromptfooConfig): PromptfooDocument {
	const editorKeys = new Set([
		"code_evaluators",
		"defaultTest",
		"evaluators",
		"commandLineOptions",
		"evaluateOptions",
		"judge_model",
		"prompt",
		"prompts",
		"providers",
		"run_config",
		"targets",
		"tests",
	]);
	return parsePromptfooDocument(
		Object.fromEntries(
			Object.entries(config).filter(([key]) => !editorKeys.has(key))
		)
	);
}

function promptfooRunConfig(config: PromptfooConfig): PromptfooDocument {
	const merged: PromptfooDocument = {};
	for (const key of ["commandLineOptions", "evaluateOptions", "run_config"]) {
		const source = config[key];
		if (isRecord(source)) {
			Object.assign(merged, source);
		}
	}
	return merged;
}

function numericRunOption(
	config: PromptfooDocument,
	...keys: string[]
): number | undefined {
	for (const key of keys) {
		if (isNumber(config[key])) {
			return config[key];
		}
	}
	return undefined;
}

function runTagsFromConfig(config: PromptfooDocument): string {
	return isRecord(config.tags)
		? Object.entries(config.tags)
				.filter((entry): entry is [string, string] => isString(entry[1]))
				.map(([key, value]) => `${key}=${value}`)
				.join(", ")
		: "";
}

interface PromptVariantRow {
	content: string;
	id: string;
	messages: EvalMessage[];
	name: string;
	type: "chat" | "text";
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
		context: test.context,
		expected: test.expected ?? "",
		inheritDefaultTest: test.inheritDefaultTest,
		id: test.id ?? crypto.randomUUID(),
		input: test.prompt ?? "",
		messages: test.messages,
		metadata: test.metadata,
		name: test.description || `Case ${index + 1}`,
		options: test.options,
		provider: test.provider,
		providerOutput: test.providerOutput,
		providers: test.providers,
		threshold: test.threshold === undefined ? "" : String(test.threshold),
		vars: test.vars,
	};
}

function rowToPromptfooTest(row: TestCaseRow): PromptfooTest {
	return {
		assertions: row.assertions,
		context: parsePromptfooValue(row.context),
		description: row.name,
		expected: row.expected.trim() || undefined,
		inheritDefaultTest: row.inheritDefaultTest,
		messages: row.messages,
		metadata: parsePromptfooDocument(row.metadata),
		options: parsePromptfooDocument(row.options),
		prompt: row.input || undefined,
		provider: row.provider,
		providerOutput: parsePromptfooValue(row.providerOutput),
		providers: row.providers,
		id: row.id,
		threshold: parseThreshold(row.threshold),
		vars: parsePromptfooDocument(row.vars),
	};
}

function suiteConfigFromEditor(
	promptDraft: string,
	variants: PromptVariantRow[],
	rows: TestCaseRow[],
	providers: string[],
	judgeModel: string,
	evaluators: string[],
	codeEvaluators: CodeEvaluatorSpec[] = [],
	defaultTest?: PromptfooDocument,
	runConfig?: PromptfooDocument,
	configExtras: PromptfooDocument = {}
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
	const config = {
		...configExtras,
		evaluators,
		judge_model: judgeModel.trim() || undefined,
		prompts,
		providers,
		tests: rows.map(rowToPromptfooTest),
	};
	const imported = parsePromptfooDocument(config);
	if (defaultTest && Object.keys(defaultTest).length > 0) {
		imported.defaultTest = defaultTest;
	}
	if (runConfig && Object.keys(runConfig).length > 0) {
		imported.run_config = runConfig;
	}
	if (codeEvaluators.length > 0) {
		imported.code_evaluators = parsePromptfooValue(codeEvaluators);
	}
	return normalizePromptfooConfig(imported);
}

function runConfigFromEditor(
	maxConcurrency: number,
	timeoutMs: number,
	repeat: number,
	cache: boolean,
	tags: string
) {
	return {
		cache,
		max_concurrency: maxConcurrency,
		repeat,
		tags: parseRunTags(tags),
		timeout_ms: timeoutMs,
	};
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
	const [codeEvaluators, setCodeEvaluators] = useState<CodeEvaluatorSpec[]>(
		() => localSuite.codeEvaluators ?? []
	);
	const [configExtras, setConfigExtras] = useState<PromptfooDocument>({});
	const [codeEvaluatorText, setCodeEvaluatorText] = useState(() =>
		JSON.stringify(localSuite.codeEvaluators ?? [], null, 2)
	);
	const [defaultTest, setDefaultTest] = useState<PromptfooDocument>(
		() => localSuite.defaultTest ?? {}
	);
	const [defaultTestText, setDefaultTestText] = useState(() =>
		JSON.stringify(localSuite.defaultTest ?? {}, null, 2)
	);
	const [extraModels, setExtraModels] = useState<string[]>(
		() => localSuite.extraModels
	);
	const [newModel, setNewModel] = useState("");
	const [judgeModel, setJudgeModel] = useState(() => localSuite.judgeModel);
	const [evaluatorIds, setEvaluatorIds] = useState<string[]>(
		() => localSuite.evaluatorIds
	);
	const [maxConcurrency, setMaxConcurrency] = useState(
		() => localSuite.maxConcurrency ?? 4
	);
	const [timeoutMs, setTimeoutMs] = useState(
		() => localSuite.timeoutMs ?? 120_000
	);
	const [repeat, setRepeat] = useState(() => localSuite.repeat ?? 1);
	const [cache, setCache] = useState(true);
	const [runTags, setRunTags] = useState(() =>
		Object.entries(localSuite.tags ?? {})
			.map(([key, value]) => `${key}=${value}`)
			.join(", ")
	);
	const [runPrefix, setRunPrefix] = useState("");
	const [runSuffix, setRunSuffix] = useState("");
	const [suite, setSuite] = useState<PromptSuiteRecord | null>(null);
	const [suiteName, setSuiteName] = useState("Promptfoo regression suite");
	const [suiteVersions, setSuiteVersions] = useState<PromptSuiteVersionMeta[]>(
		[]
	);
	const [suiteRuns, setSuiteRuns] = useState<PromptRunMeta[]>([]);
	const [suiteLoading, setSuiteLoading] = useState(false);
	const [suiteSaving, setSuiteSaving] = useState(false);
	const [suiteError, setSuiteError] = useState<string | null>(null);
	const [pendingImport, setPendingImport] =
		useState<PendingPromptfooImport | null>(null);
	const [saveLabel, setSaveLabel] = useState("");
	const [exportFormat, setExportFormat] = useState<
		"csv" | "json" | "jsonl" | "yaml"
	>("yaml");
	const [variants, setVariants] = useState<PromptVariantRow[]>([]);
	const [running, setRunning] = useState(false);
	const [results, setResults] = useState<PromptVariantRun[] | null>(null);
	const [activeRunId, setActiveRunId] = useState<string | null>(null);
	const [reviews, setReviews] = useState<Record<string, PromptReview>>({});
	const [comparisonResults, setComparisonResults] = useState<
		PromptVariantRun[] | null
	>(null);
	const [comparisonRunId, setComparisonRunId] = useState<string | null>(null);
	useEffect(() => {
		setCodeEvaluatorText(JSON.stringify(codeEvaluators, null, 2));
	}, [codeEvaluators]);
	useEffect(() => {
		setDefaultTestText(JSON.stringify(defaultTest, null, 2));
	}, [defaultTest]);
	const [error, setError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const loadedSuiteAgentRef = useRef<string | null>(null);
	const importAppliedRef = useRef(false);

	useEffect(() => () => abortRef.current?.abort(), []);

	useEffect(() => {
		let cancelled = false;
		importAppliedRef.current = false;
		const load = async () => {
			loadedSuiteAgentRef.current = null;
			setSuiteLoading(true);
			setSuiteError(null);
			setResults(null);
			setActiveRunId(null);
			setReviews({});
			setComparisonResults(null);
			setComparisonRunId(null);
			try {
				if (!agentId) {
					return;
				}
				const suites = await listPromptSuites(target, agentId);
				if (cancelled || importAppliedRef.current) {
					return;
				}
				const nextSuite = suites[0];
				if (!nextSuite) {
					const local = loadTestSuite(agentId);
					setSuite(null);
					setConfigExtras({});
					setSuiteName("Promptfoo regression suite");
					setCodeEvaluators(local.codeEvaluators ?? []);
					setDefaultTest(local.defaultTest ?? {});
					setRows(local.rows);
					setExtraModels(local.extraModels);
					setJudgeModel(local.judgeModel);
					setEvaluatorIds(local.evaluatorIds);
					setMaxConcurrency(local.maxConcurrency ?? 4);
					setTimeoutMs(local.timeoutMs ?? 120_000);
					setRepeat(local.repeat ?? 1);
					setRunTags(
						Object.entries(local.tags ?? {})
							.map(([key, value]) => `${key}=${value}`)
							.join(", ")
					);
					setVariants([]);
					setSuiteVersions([]);
					setSuiteRuns([]);
					setComparisonResults(null);
					setComparisonRunId(null);
					return;
				}
				const config = normalizePromptfooConfig(nextSuite.config);
				setSuite(nextSuite);
				setConfigExtras(promptfooConfigExtras(config));
				setSuiteName(nextSuite.name);
				setCodeEvaluators(parseCodeEvaluators(config.code_evaluators));
				setDefaultTest(isRecord(config.defaultTest) ? config.defaultTest : {});
				setRows(config.tests.map(promptfooTestToRow));
				setExtraModels(config.providers);
				setJudgeModel(isString(config.judge_model) ? config.judge_model : "");
				setEvaluatorIds(
					Array.isArray(config.evaluators)
						? config.evaluators.filter((value): value is string =>
								isString(value)
							)
						: []
				);
				const savedRunConfig = promptfooRunConfig(config);
				setMaxConcurrency(
					numericRunOption(
						savedRunConfig,
						"max_concurrency",
						"maxConcurrency"
					) ?? 4
				);
				setTimeoutMs(
					numericRunOption(savedRunConfig, "timeout_ms", "timeoutMs") ?? 120_000
				);
				setRepeat(numericRunOption(savedRunConfig, "repeat") ?? 1);
				setCache(savedRunConfig.cache !== false);
				setRunTags(runTagsFromConfig(savedRunConfig));
				setVariants(config.prompts.slice(1).map(promptVariantFromConfig));
				if (config.prompts[0]?.content) {
					onPromptChange(config.prompts[0].content);
				}
				const [versions, runs] = await Promise.all([
					listPromptSuiteVersions(target, nextSuite.id),
					listPromptRuns(target, nextSuite.id),
				]);
				if (!(cancelled || importAppliedRef.current)) {
					setSuiteVersions(versions);
					setSuiteRuns(runs);
					const linkedRunId = linkedPromptRunId();
					if (linkedRunId && runs.some((run) => run.id === linkedRunId)) {
						const [linkedRun, linkedReviews] = await Promise.all([
							getPromptRun(target, nextSuite.id, linkedRunId),
							listPromptReviews(target, nextSuite.id, linkedRunId),
						]);
						const linkedResults = isRecord(linkedRun.result)
							? linkedRun.result.variants
							: undefined;
						if (
							!(cancelled || importAppliedRef.current) &&
							Array.isArray(linkedResults)
						) {
							setResults(promptVariantRunsSchema.parse(linkedResults));
							setActiveRunId(linkedRunId);
							setReviews(
								Object.fromEntries(
									linkedReviews.map((review) => [review.resultKey, review])
								)
							);
						}
					}
				}
			} catch (loadError) {
				if (!(cancelled || importAppliedRef.current)) {
					// Core may be on an older build while the editor is being upgraded;
					// preserve the local draft and surface the durable-sync state.
					const local = agentId ? loadTestSuite(agentId) : null;
					if (local) {
						setRows(local.rows);
						setCodeEvaluators(local.codeEvaluators ?? []);
						setDefaultTest(local.defaultTest ?? {});
						setExtraModels(local.extraModels);
						setJudgeModel(local.judgeModel);
						setEvaluatorIds(local.evaluatorIds);
						setMaxConcurrency(local.maxConcurrency ?? 4);
						setTimeoutMs(local.timeoutMs ?? 120_000);
						setRepeat(local.repeat ?? 1);
						setRunTags(
							Object.entries(local.tags ?? {})
								.map(([key, value]) => `${key}=${value}`)
								.join(", ")
						);
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
		persistTestSuite(agentId, {
			codeEvaluators,
			defaultTest,
			evaluatorIds,
			extraModels,
			judgeModel,
			maxConcurrency,
			repeat,
			tags: parseRunTags(runTags),
			timeoutMs,
			rows,
		});
	}, [
		agentId,
		codeEvaluators,
		defaultTest,
		evaluatorIds,
		extraModels,
		judgeModel,
		maxConcurrency,
		repeat,
		runTags,
		timeoutMs,
		rows,
	]);

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

	const moveRow = useCallback((id: string, direction: -1 | 1) => {
		setRows((previous) => {
			const index = previous.findIndex((row) => row.id === id);
			const nextIndex = index + direction;
			if (index < 0 || nextIndex < 0 || nextIndex >= previous.length) {
				return previous;
			}
			const next = previous.slice();
			[next[index], next[nextIndex]] = [next[nextIndex], next[index]];
			return next;
		});
	}, []);

	const duplicateRow = useCallback((id: string) => {
		setRows((previous) => {
			const index = previous.findIndex((row) => row.id === id);
			const source = previous[index];
			if (!source) {
				return previous;
			}
			const duplicate = {
				...source,
				id: crypto.randomUUID(),
				name: `${source.name || `Case ${index + 1}`} copy`,
				metadata: { ...source.metadata },
				options: { ...source.options },
				providers: [...source.providers],
				vars: { ...source.vars },
				assertions: source.assertions.map((assertion) =>
					structuredClone(assertion)
				),
			};
			return [
				...previous.slice(0, index + 1),
				duplicate,
				...previous.slice(index + 1),
			];
		});
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

	const moveVariant = useCallback((id: string, direction: -1 | 1) => {
		setVariants((previous) => {
			const index = previous.findIndex((variant) => variant.id === id);
			const nextIndex = index + direction;
			if (index < 0 || nextIndex < 0 || nextIndex >= previous.length) {
				return previous;
			}
			const next = previous.slice();
			[next[index], next[nextIndex]] = [next[nextIndex], next[index]];
			return next;
		});
	}, []);

	const duplicateVariant = useCallback((id: string) => {
		setVariants((previous) => {
			const index = previous.findIndex((variant) => variant.id === id);
			const source = previous[index];
			if (!source) {
				return previous;
			}
			const duplicate = {
				...source,
				id: `prompt-${crypto.randomUUID()}`,
				messages: source.messages.map((message) => ({ ...message })),
				name: `${source.name || `Variant ${index + 1}`} copy`,
			};
			return [
				...previous.slice(0, index + 1),
				duplicate,
				...previous.slice(index + 1),
			];
		});
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
			setConfigExtras(promptfooConfigExtras(config));
			setCodeEvaluators(parseCodeEvaluators(config.code_evaluators));
			setDefaultTest(isRecord(config.defaultTest) ? config.defaultTest : {});
			setRows(config.tests.map(promptfooTestToRow));
			setExtraModels(config.providers);
			setJudgeModel(isString(config.judge_model) ? config.judge_model : "");
			setEvaluatorIds(
				Array.isArray(config.evaluators)
					? config.evaluators.filter((value): value is string =>
							isString(value)
						)
					: []
			);
			const importedRunConfig = promptfooRunConfig(config);
			setMaxConcurrency(
				numericRunOption(
					importedRunConfig,
					"max_concurrency",
					"maxConcurrency"
				) ?? 4
			);
			setTimeoutMs(
				numericRunOption(importedRunConfig, "timeout_ms", "timeoutMs") ??
					120_000
			);
			setRepeat(numericRunOption(importedRunConfig, "repeat") ?? 1);
			setCache(importedRunConfig.cache !== false);
			setRunTags(runTagsFromConfig(importedRunConfig));
			setVariants(config.prompts.slice(1).map(promptVariantFromConfig));
			if (config.prompts[0]?.content !== undefined) {
				onPromptChange(config.prompts[0].content);
			}
		},
		[onPromptChange]
	);

	const importFile = useCallback(
		async (event: React.ChangeEvent<HTMLInputElement>) => {
			const files = Array.from(event.target.files ?? []);
			const file = files[0];
			event.target.value = "";
			if (!file) {
				return;
			}
			try {
				const relatedFiles: PromptfooRelatedFiles = Object.fromEntries(
					await Promise.all(
						files
							.slice(1)
							.map(async (related) => [related.name, await related.text()])
					)
				);
				const parsed = parsePromptfooFile(
					await file.text(),
					file.name,
					relatedFiles
				);
				setPendingImport({
					config: parsed.config,
					filename: file.name,
					warnings: promptfooImportWarnings(parsed.config),
				});
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

	const applyPendingImport = useCallback(() => {
		if (!pendingImport) {
			return;
		}
		importAppliedRef.current = true;
		applyConfig(pendingImport.config);
		setSuiteName(
			pendingImport.filename.replace(/\.[^.]+$/, "") || "Imported suite"
		);
		setSuite(null);
		setSuiteVersions([]);
		setSuiteRuns([]);
		setPendingImport(null);
	}, [applyConfig, pendingImport]);

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
				evaluatorIds,
				codeEvaluators,
				defaultTest,
				runConfigFromEditor(maxConcurrency, timeoutMs, repeat, cache, runTags),
				configExtras
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
				const version = response.version;
				setSuiteVersions((prev) => [version, ...prev]);
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
		configExtras,
		judgeModel,
		evaluatorIds,
		codeEvaluators,
		defaultTest,
		maxConcurrency,
		timeoutMs,
		repeat,
		cache,
		runTags,
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
				evaluatorIds,
				codeEvaluators,
				defaultTest,
				runConfigFromEditor(maxConcurrency, timeoutMs, repeat, cache, runTags),
				configExtras
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
			codeEvaluators,
			configExtras,
			defaultTest,
			maxConcurrency,
			timeoutMs,
			repeat,
			cache,
			runTags,
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
				description: r.name.trim() || undefined,
				id: r.id,
				messages: r.messages,
				prompt: r.input,
				vars: r.vars,
				assertions: r.assertions.map(gatewayAssertion),
				context: r.context,
				expected: r.expected.trim() ? r.expected : undefined,
				threshold: parseThreshold(r.threshold),
				metadata: r.metadata,
				options: {
					cache: isBoolean(r.options.cache) ? r.options.cache : undefined,
					prefix: isString(r.options.prefix) ? r.options.prefix : undefined,
					suffix: isString(r.options.suffix) ? r.options.suffix : undefined,
					timeout_ms: isNumber(r.options.timeout_ms)
						? r.options.timeout_ms
						: undefined,
					transform: isString(r.options.transform)
						? r.options.transform
						: undefined,
					transform_vars: isString(r.options.transform_vars)
						? r.options.transform_vars
						: isString(r.options.transformVars)
							? r.options.transformVars
							: undefined,
				},
				provider: r.provider,
				providers: r.providers,
				provider_output: r.providerOutput,
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
						code_evaluators: codeEvaluators,
						dataset,
						max_concurrency: Math.max(1, Math.min(32, maxConcurrency)),
						timeout_ms: Math.max(100, Math.min(120_000, timeoutMs)),
						repeat: Math.max(1, Math.min(20, repeat)),
						cache,
						tags: parseRunTags(runTags),
						prefix: runPrefix || undefined,
						suffix: runSuffix || undefined,
						prompt_id: variant.id,
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
			setReviews({});
			setComparisonResults(null);
			setComparisonRunId(null);
			if (suite) {
				const saved = await savePromptRun(target, suite.id, {
					name: `${suiteName} · ${new Date().toLocaleString()}`,
					request: {
						dataset,
						judge_model: judgeModel,
						models: selectedModels,
						prompts: promptVariants,
						run_config: runConfigFromEditor(
							maxConcurrency,
							timeoutMs,
							repeat,
							cache,
							runTags
						),
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
		cache,
		codeEvaluators,
		judgeModel,
		evaluatorIds,
		maxConcurrency,
		model,
		promptVariants,
		repeat,
		rows,
		runPrefix,
		runSuffix,
		runTags,
		selectedModels,
		suite,
		suiteName,
		target,
		timeoutMs,
	]);

	const handleRun = useCallback(() => {
		run().catch(() => {
			// errors are surfaced via setError inside run().
		});
	}, [run]);

	const handleLoadRun = useCallback(
		async (runId: string) => {
			if (!suite) {
				return;
			}
			try {
				const [saved, savedReviews] = await Promise.all([
					getPromptRun(target, suite.id, runId),
					listPromptReviews(target, suite.id, runId),
				]);
				const savedResults = isRecord(saved.result)
					? saved.result.variants
					: undefined;
				if (Array.isArray(savedResults)) {
					setResults(promptVariantRunsSchema.parse(savedResults));
					setActiveRunId(runId);
					setReviews(
						Object.fromEntries(
							savedReviews.map((review) => [review.resultKey, review])
						)
					);
				}
			} catch (loadError) {
				setError(
					loadError instanceof Error ? loadError.message : "Failed to load run"
				);
			}
		},
		[suite, target]
	);

	const handleRenameRun = useCallback(
		async (runId: string, name: string) => {
			if (!(suite && name.trim())) {
				return;
			}
			try {
				const updated = await renamePromptRun(
					target,
					suite.id,
					runId,
					name.trim()
				);
				setSuiteRuns((prev) =>
					prev.map((run) => (run.id === runId ? updated : run))
				);
			} catch (renameError) {
				setError(
					renameError instanceof Error
						? renameError.message
						: "Failed to rename run"
				);
			}
		},
		[suite, target]
	);

	const handleDuplicateRun = useCallback(
		async (runId: string) => {
			if (!suite) {
				return;
			}
			try {
				const duplicate = await duplicatePromptRun(target, suite.id, runId);
				setSuiteRuns((prev) => [duplicate, ...prev]);
			} catch (duplicateError) {
				setError(
					duplicateError instanceof Error
						? duplicateError.message
						: "Failed to duplicate run"
				);
			}
		},
		[suite, target]
	);

	const handleDeleteRun = useCallback(
		async (runId: string) => {
			if (!suite) {
				return;
			}
			try {
				await deletePromptRun(target, suite.id, runId);
				setSuiteRuns((prev) => prev.filter((run) => run.id !== runId));
				if (comparisonRunId === runId) {
					setComparisonResults(null);
					setComparisonRunId(null);
				}
				if (activeRunId === runId) {
					setActiveRunId(null);
					setResults(null);
					setReviews({});
				}
			} catch (deleteError) {
				setError(
					deleteError instanceof Error
						? deleteError.message
						: "Failed to delete run"
				);
			}
		},
		[activeRunId, comparisonRunId, suite, target]
	);

	const handleCompareRun = useCallback(
		async (runId: string) => {
			if (!(suite && activeRunId) || activeRunId === runId) {
				setError(
					"Select one run first, then choose a different run to compare."
				);
				return;
			}
			try {
				const saved = await getPromptRun(target, suite.id, runId);
				const savedResults = isRecord(saved.result)
					? saved.result.variants
					: undefined;
				if (Array.isArray(savedResults)) {
					setComparisonResults(promptVariantRunsSchema.parse(savedResults));
					setComparisonRunId(runId);
				}
			} catch (compareError) {
				setError(
					compareError instanceof Error
						? compareError.message
						: "Failed to compare run"
				);
			}
		},
		[activeRunId, suite, target]
	);

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
					<Label htmlFor="promptfoo-suite-name" size="caption">
						Suite name
					</Label>
					<Input
						disabled={locked}
						id="promptfoo-suite-name"
						onChange={(event) => setSuiteName(event.target.value)}
						size="compact"
						value={suiteName}
					/>
				</div>
				<div className="flex min-w-44 flex-col gap-1">
					<Label htmlFor="promptfoo-save-label" size="caption">
						Version label (optional)
					</Label>
					<Input
						disabled={locked}
						id="promptfoo-save-label"
						onChange={(event) => setSaveLabel(event.target.value)}
						placeholder="Baseline, stricter rubric…"
						size="compact"
						value={saveLabel}
					/>
				</div>
				<Button
					disabled={locked || !agentId || suiteSaving || suiteLoading}
					loading={suiteSaving}
					onClick={() => saveSuite().catch(() => undefined)}
					size="sm"
				>
					Save suite
				</Button>
				{suiteVersions.length > 0 ? (
					<NativeSelect
						appearance="compact"
						aria-label="Restore suite version"
						className="max-w-44"
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
						multiple
						onChange={(event) => importFile(event).catch(() => undefined)}
						type="file"
					/>
					<span className="rounded-md border px-2 py-1.5 text-xs hover:bg-muted">
						Import
					</span>
				</label>
				<NativeSelect
					appearance="compact"
					aria-label="Export format"
					className="w-24"
					onChange={(event) =>
						setExportFormat(
							z.enum(["yaml", "json", "jsonl", "csv"]).parse(event.target.value)
						)
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
				<p className="text-status-destructive text-xs">{suiteError}</p>
			) : null}
			{pendingImport ? (
				<div
					aria-live="polite"
					className="flex flex-col gap-2 rounded-lg border border-dashed bg-muted/20 p-3"
					data-testid="promptfoo-import-preview"
				>
					<div>
						<p className="font-medium text-xs">Import ready</p>
						<p className="type-caption text-muted-foreground">
							{pendingImport.filename} contains{" "}
							{pendingImport.config.prompts.length} prompt
							{pendingImport.config.prompts.length === 1 ? "" : "s"},{" "}
							{pendingImport.config.tests.length} test
							{pendingImport.config.tests.length === 1 ? "" : "s"}, and{" "}
							{pendingImport.config.providers.length} provider
							{pendingImport.config.providers.length === 1 ? "" : "s"}. Applying
							it replaces the current draft.
						</p>
					</div>
					{pendingImport.warnings.map((warning) => (
						<p className="type-caption text-status-warning" key={warning}>
							{warning}
						</p>
					))}
					<div className="flex flex-wrap gap-2">
						<Button onClick={applyPendingImport} size="sm">
							Apply import
						</Button>
						<Button
							onClick={() => setPendingImport(null)}
							size="sm"
							variant="ghost"
						>
							Cancel
						</Button>
					</div>
				</div>
			) : null}

			<PromptVariantsEditor
				locked={locked}
				onAdd={addVariant}
				onDuplicate={duplicateVariant}
				onMove={moveVariant}
				onRemove={removeVariant}
				onUpdate={updateVariant}
				variants={variants}
			/>

			{/* Test-case table */}
			<TestCaseTable
				locked={locked}
				onAddRow={addRow}
				onDuplicateRow={duplicateRow}
				onMoveRow={moveRow}
				onRemoveRow={removeRow}
				onUpdateRow={updateRow}
				rows={rows}
			/>

			{/* Model + judge inputs */}
			<ModelControls
				extraModels={extraModels}
				judgeModel={judgeModel}
				locked={locked}
				newModel={newModel}
				onAddModel={addExtraModel}
				onJudgeChange={setJudgeModel}
				onNewModelChange={setNewModel}
				onRemoveModel={removeExtraModel}
				primaryModel={model}
			/>
			<div className="flex flex-col gap-1 rounded-lg bg-muted/20 p-3">
				<Label htmlFor="promptfoo-evaluators" size="caption">
					Registry evaluators (optional, comma-separated)
				</Label>
				<Input
					disabled={locked}
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
					size="dense"
					value={evaluatorIds.join(", ")}
				/>
				<p className="type-compact text-muted-foreground">
					Uses the shared Gateway evaluator catalog in addition to inline
					assertions.
				</p>
			</div>

			<details className="rounded-lg bg-muted/20 p-3" open>
				<summary className="cursor-pointer font-medium text-xs">
					Run options and Promptfoo defaults
				</summary>
				<div className="mt-3 flex flex-col gap-3">
					<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
						<div className="flex flex-col gap-1">
							<Label htmlFor="promptfoo-concurrency" size="caption">
								Concurrency
							</Label>
							<Input
								disabled={locked}
								id="promptfoo-concurrency"
								max={32}
								min={1}
								onChange={(event) =>
									setMaxConcurrency(
										Math.max(1, Math.min(32, Number(event.target.value) || 1))
									)
								}
								size="dense"
								type="number"
								value={maxConcurrency}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor="promptfoo-timeout" size="caption">
								Timeout (ms)
							</Label>
							<Input
								disabled={locked}
								id="promptfoo-timeout"
								max={120_000}
								min={100}
								onChange={(event) =>
									setTimeoutMs(
										Math.max(
											100,
											Math.min(120_000, Number(event.target.value) || 100)
										)
									)
								}
								size="dense"
								type="number"
								value={timeoutMs}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor="promptfoo-repeat" size="caption">
								Repeat cases
							</Label>
							<Input
								disabled={locked}
								id="promptfoo-repeat"
								max={20}
								min={1}
								onChange={(event) =>
									setRepeat(
										Math.max(1, Math.min(20, Number(event.target.value) || 1))
									)
								}
								size="dense"
								type="number"
								value={repeat}
							/>
						</div>
						<label className="type-caption flex items-center justify-between gap-2 rounded-md border px-2">
							<span>
								Cache outputs
								<span className="type-compact block text-muted-foreground">
									Reuse identical inputs in this run
								</span>
							</span>
							<Switch
								checked={cache}
								disabled={locked}
								id="promptfoo-cache"
								onCheckedChange={setCache}
							/>
						</label>
					</div>
					<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
						<div className="flex flex-col gap-1">
							<Label htmlFor="promptfoo-tags" size="caption">
								Run tags (key=value, comma-separated)
							</Label>
							<Input
								disabled={locked}
								id="promptfoo-tags"
								onChange={(event) => setRunTags(event.target.value)}
								placeholder="branch=main, owner=evals"
								size="dense"
								value={runTags}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor="promptfoo-prefix-suffix" size="caption">
								Prompt prefix / suffix
							</Label>
							<div className="flex gap-1">
								<Input
									aria-label="Prompt prefix"
									disabled={locked}
									onChange={(event) => setRunPrefix(event.target.value)}
									placeholder="prefix"
									size="dense"
									value={runPrefix}
								/>
								<Input
									aria-label="Prompt suffix"
									disabled={locked}
									onChange={(event) => setRunSuffix(event.target.value)}
									placeholder="suffix"
									size="dense"
									value={runSuffix}
								/>
							</div>
						</div>
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor="promptfoo-default-test" size="caption">
							Default test JSON (inherited by imported cases)
						</Label>
						<Textarea
							disabled={locked}
							id="promptfoo-default-test"
							onChange={(event) => {
								setDefaultTestText(event.target.value);
								try {
									const parsed = parsePromptfooValue(
										JSON.parse(event.target.value)
									);
									if (isRecord(parsed)) {
										setDefaultTest(parsed);
									}
								} catch {
									// Keep the last valid object while editing JSON.
								}
							}}
							placeholder='{"vars":{"locale":"en"},"assert":[{"type":"contains","value":"{{answer}}"}]}'
							size="dense"
							value={defaultTestText}
							variant="code"
						/>
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor="promptfoo-code-evaluators" size="caption">
							Custom JS/Python evaluators (Core sandbox)
						</Label>
						<Textarea
							disabled={locked}
							id="promptfoo-code-evaluators"
							onChange={(event) => {
								setCodeEvaluatorText(event.target.value);
								try {
									setCodeEvaluators(
										parseCodeEvaluators(
											parsePromptfooValue(JSON.parse(event.target.value))
										)
									);
								} catch {
									// Keep the last valid evaluator list while editing JSON.
								}
							}}
							placeholder='[{"id":"safe_output","lang":"js","source":"({ score: output.includes(\"safe\") ? 1 : 0 })"}]'
							size="compact"
							value={codeEvaluatorText}
							variant="code"
						/>
						<p className="type-compact text-muted-foreground">
							Code is never run in the renderer or Gateway; Core reports
							unavailable sandbox runtimes as not executed.
						</p>
					</div>
				</div>
			</details>

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

			{error ? (
				<p className="text-status-destructive text-xs">{error}</p>
			) : null}

			<PromptRunHistory
				onCompare={handleCompareRun}
				onDelete={handleDeleteRun}
				onDuplicate={handleDuplicateRun}
				onRename={handleRenameRun}
				onSelect={handleLoadRun}
				runs={suiteRuns}
				selectedRunId={activeRunId}
			/>

			{/* Results matrix */}
			{results ? (
				<ResultsMatrix
					comparisonResults={comparisonResults}
					comparisonRunId={comparisonRunId}
					model={model}
					onReviewSaved={(review) =>
						setReviews((previous) => ({
							...previous,
							[review.resultKey]: review,
						}))
					}
					results={results}
					reviews={reviews}
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
	onDuplicate,
	onMove,
	onRemove,
	onUpdate,
	variants,
}: {
	locked: boolean;
	onAdd: () => void;
	onDuplicate: (id: string) => void;
	onMove: (id: string, direction: -1 | 1) => void;
	onRemove: (id: string) => void;
	onUpdate: (id: string, patch: Partial<PromptVariantRow>) => void;
	variants: PromptVariantRow[];
}) {
	return (
		<div className="flex flex-col gap-2 rounded-lg bg-muted/20 p-3">
			<div className="flex items-center gap-2">
				<span className="font-medium text-xs">Prompt variants</span>
				<span className="type-caption text-muted-foreground">
					Run text or multi-turn prompt variants through the same test matrix.
				</span>
				<Button disabled={locked} onClick={onAdd} size="sm" variant="ghost">
					<HugeiconsIcon className="size-3" icon={Add01Icon} />
					Add variant
				</Button>
			</div>
			{variants.length === 0 ? (
				<p className="type-caption text-muted-foreground">
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
							aria-label={`Prompt variant ${index + 1} name`}
							className="max-w-48"
							disabled={locked}
							onChange={(event) =>
								onUpdate(variant.id, { name: event.target.value })
							}
							size="dense"
							value={variant.name || `Variant ${index + 1}`}
						/>
						<Button
							aria-label={`Move ${variant.name || `variant ${index + 1}`} up`}
							className="size-7"
							disabled={index === 0 || locked}
							onClick={() => onMove(variant.id, -1)}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-3" icon={ArrowUp01Icon} />
						</Button>
						<Button
							aria-label={`Move ${variant.name || `variant ${index + 1}`} down`}
							className="size-7"
							disabled={index === variants.length - 1 || locked}
							onClick={() => onMove(variant.id, 1)}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-3" icon={ArrowDown01Icon} />
						</Button>
						<Button
							aria-label={`Duplicate ${variant.name || `variant ${index + 1}`}`}
							className="size-7"
							disabled={locked}
							onClick={() => onDuplicate(variant.id)}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-3" icon={Copy01Icon} />
						</Button>
						<NativeSelect
							appearance="dense"
							aria-label={`Prompt variant ${index + 1} type`}
							className="w-24"
							disabled={locked}
							onChange={(event) =>
								onUpdate(variant.id, {
									messages:
										event.target.value === "chat" ? variant.messages : [],
									type: z.enum(["text", "chat"]).parse(event.target.value),
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
							aria-label="Variant chat messages (JSON)"
							disabled={locked}
							onChange={(event) => {
								try {
									const parsed = parsePromptfooValue(
										JSON.parse(event.target.value)
									);
									if (!Array.isArray(parsed)) {
										return;
									}
									onUpdate(variant.id, {
										messages: parseEvalMessages(parsed),
									});
								} catch {
									// Keep the last valid message list until the JSON is complete.
								}
							}}
							placeholder='[{"role":"user","content":"Hello {{name}}"}]'
							size="compact"
							value={JSON.stringify(variant.messages, null, 2)}
							variant="code"
						/>
					) : (
						<Textarea
							aria-label="Variant system prompt"
							disabled={locked}
							onChange={(event) =>
								onUpdate(variant.id, { content: event.target.value })
							}
							placeholder="A second system prompt variant. {{vars}} are rendered per case."
							size="compact"
							value={variant.content}
							variant="code"
						/>
					)}
				</div>
			))}
		</div>
	);
}

function PromptRunHistory({
	onCompare,
	onDelete,
	onDuplicate,
	onRename,
	onSelect,
	runs,
	selectedRunId,
}: {
	onCompare: (runId: string) => Promise<void>;
	onDelete: (runId: string) => Promise<void>;
	onDuplicate: (runId: string) => Promise<void>;
	onRename: (runId: string, name: string) => Promise<void>;
	onSelect: (runId: string) => Promise<void>;
	runs: PromptRunMeta[];
	selectedRunId: string | null;
}) {
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingName, setEditingName] = useState("");
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	if (runs.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-muted/20 p-2">
			<span className="type-caption mr-1 font-medium">Runs</span>
			{runs.slice(0, 8).map((run) => (
				<div className="flex items-center gap-0.5" key={run.id}>
					{editingId === run.id ? (
						<>
							<Input
								aria-label={`Rename ${run.name}`}
								className="w-44"
								onChange={(event) => setEditingName(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										onRename(run.id, editingName).catch(() => undefined);
										setEditingId(null);
									}
									if (event.key === "Escape") {
										setEditingId(null);
									}
								}}
								size="caption"
								value={editingName}
							/>
							<Button
								aria-label={`Save name for ${run.name}`}
								className="size-7"
								disabled={!editingName.trim()}
								onClick={() => {
									onRename(run.id, editingName).catch(() => undefined);
									setEditingId(null);
								}}
								size="icon-sm"
								variant="ghost"
							>
								Save
							</Button>
						</>
					) : (
						<Button
							className="max-w-56"
							onClick={() => onSelect(run.id).catch(() => undefined)}
							size="caption"
							variant={selectedRunId === run.id ? "secondary" : "ghost"}
						>
							<span className="truncate" title={run.name}>
								{run.name}
							</span>
						</Button>
					)}
					{editingId !== run.id && confirmDeleteId !== run.id ? (
						<>
							<Button
								aria-label={`Rename ${run.name}`}
								className="size-7"
								onClick={() => {
									setEditingId(run.id);
									setEditingName(run.name);
								}}
								size="icon-sm"
								variant="ghost"
							>
								<HugeiconsIcon className="size-3" icon={Edit02Icon} />
							</Button>
							<Button
								aria-label={`Duplicate ${run.name}`}
								className="size-7"
								onClick={() => onDuplicate(run.id).catch(() => undefined)}
								size="icon-sm"
								variant="ghost"
							>
								<HugeiconsIcon className="size-3" icon={Copy01Icon} />
							</Button>
							<Button
								aria-label={`Compare ${run.name}`}
								onClick={() => onCompare(run.id).catch(() => undefined)}
								size="micro-dense"
								variant="ghost"
							>
								Compare
							</Button>
							<Button
								aria-label={`Delete ${run.name}`}
								className="size-7"
								onClick={() => setConfirmDeleteId(run.id)}
								size="icon-sm"
								variant="ghost"
							>
								<HugeiconsIcon className="size-3" icon={Delete02Icon} />
							</Button>
						</>
					) : null}
					{confirmDeleteId === run.id ? (
						<>
							<span className="type-compact text-status-destructive">
								Delete?
							</span>
							<Button
								onClick={() => {
									onDelete(run.id).catch(() => undefined);
									setConfirmDeleteId(null);
								}}
								size="micro-dense"
								variant="destructive"
							>
								Delete
							</Button>
							<Button
								onClick={() => setConfirmDeleteId(null)}
								size="micro-dense"
								variant="ghost"
							>
								Cancel
							</Button>
						</>
					) : null}
				</div>
			))}
		</div>
	);
}

// ── Test-case table ────────────────────────────────────────────────────────────

interface TestCaseTableProps {
	locked: boolean;
	onAddRow: () => void;
	onDuplicateRow: (id: string) => void;
	onMoveRow: (id: string, direction: -1 | 1) => void;
	onRemoveRow: (id: string) => void;
	onUpdateRow: (id: string, patch: Partial<TestCaseRow>) => void;
	rows: TestCaseRow[];
}

function TestCaseTable({
	locked,
	rows,
	onAddRow,
	onDuplicateRow,
	onMoveRow,
	onRemoveRow,
	onUpdateRow,
}: TestCaseTableProps) {
	return (
		<fieldset className="flex flex-col gap-2" disabled={locked}>
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
					onDuplicate={() => onDuplicateRow(row.id)}
					onMove={(direction) => onMoveRow(row.id, direction)}
					onRemove={onRemoveRow}
					onUpdate={onUpdateRow}
					row={row}
					rowCount={rows.length}
				/>
			))}
			<div>
				<Button onClick={onAddRow} size="sm" variant="ghost">
					<HugeiconsIcon className="size-3" icon={Add01Icon} />
					Add test case
				</Button>
			</div>
		</fieldset>
	);
}

interface TestCaseRowEditorProps {
	index: number;
	onDuplicate: () => void;
	onMove: (direction: -1 | 1) => void;
	onRemove: (id: string) => void;
	onUpdate: (id: string, patch: Partial<TestCaseRow>) => void;
	row: TestCaseRow;
	rowCount: number;
}

function TestCaseRowEditor({
	row,
	index,
	onDuplicate,
	onMove,
	onRemove,
	rowCount,
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
					aria-label={`Case ${index + 1} id`}
					className="max-w-36"
					onChange={(e) => onUpdate(row.id, { id: e.target.value })}
					placeholder="Stable id"
					size="micro-dense"
					value={row.id}
					variant="code"
				/>
				<Input
					aria-label={`Case ${index + 1} name`}
					autoComplete="off"
					className="max-w-48"
					name={`test-case-name-${row.id}`}
					onChange={(e) => onUpdate(row.id, { name: e.target.value })}
					placeholder="Name (optional)"
					size="dense"
					value={row.name}
				/>
				<Button
					aria-label={`Move case ${index + 1} up`}
					className="size-7"
					disabled={index === 0}
					onClick={() => onMove(-1)}
					size="icon-sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3" icon={ArrowUp01Icon} />
				</Button>
				<Button
					aria-label={`Move case ${index + 1} down`}
					className="size-7"
					disabled={index === rowCount - 1}
					onClick={() => onMove(1)}
					size="icon-sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3" icon={ArrowDown01Icon} />
				</Button>
				<Button
					aria-label={`Duplicate test case ${index + 1}`}
					className="size-7"
					onClick={onDuplicate}
					size="icon-sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3" icon={Copy01Icon} />
				</Button>
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
				<Label htmlFor={`test-input-${row.id}`} size="compact">
					User message
				</Label>
				<Textarea
					id={`test-input-${row.id}`}
					name={`test-input-${row.id}`}
					onChange={(e) => onUpdate(row.id, { input: e.target.value })}
					placeholder="The user message. {{vars}} allowed."
					size="dense"
					value={row.input}
					variant="code"
				/>
			</div>

			{suggestedVars.length > 0 ? (
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
					{suggestedVars.map((name) => (
						<div className="flex flex-col gap-1" key={name}>
							<Label size="caption">{name}</Label>
							<Input
								aria-label={name}
								autoComplete="off"
								name={`test-variable-${row.id}-${name}`}
								onChange={(e) => handleVarChange(name, e.target.value)}
								placeholder={`Value for {{${name}}}`}
								size="dense"
								value={displayVariable(row.vars[name])}
							/>
						</div>
					))}
				</div>
			) : null}

			<div className="flex flex-col gap-1">
				<Label htmlFor={`test-messages-${row.id}`} size="compact">
					Chat messages (optional JSON)
				</Label>
				<Textarea
					id={`test-messages-${row.id}`}
					onChange={(event) => {
						try {
							const parsed = parsePromptfooValue(
								JSON.parse(event.target.value)
							);
							if (!Array.isArray(parsed)) {
								return;
							}
							onUpdate(row.id, {
								messages: parseEvalMessages(parsed),
							});
						} catch {
							// Keep the last valid list while the user edits JSON.
						}
					}}
					placeholder='[{"role":"user","content":"Question for {{name}}"}]'
					size="dense"
					value={JSON.stringify(row.messages ?? [], null, 2)}
					variant="code"
				/>
			</div>

			<div className="flex flex-col gap-1">
				<Label htmlFor={`test-expected-${row.id}`} size="compact">
					Expected (optional substring)
				</Label>
				<Input
					id={`test-expected-${row.id}`}
					name={`test-expected-${row.id}`}
					onChange={(e) => onUpdate(row.id, { expected: e.target.value })}
					placeholder="Substring the response should contain"
					size="dense"
					value={row.expected}
				/>
			</div>

			<div className="flex flex-col gap-1">
				<Label htmlFor={`test-context-${row.id}`} size="compact">
					Reference/context (optional JSON)
				</Label>
				<Textarea
					id={`test-context-${row.id}`}
					onChange={(event) => {
						if (!event.target.value.trim()) {
							onUpdate(row.id, { context: undefined });
							return;
						}
						try {
							onUpdate(row.id, {
								context: parsePromptfooValue(JSON.parse(event.target.value)),
							});
						} catch {
							// Keep the last valid context while the JSON is edited.
						}
					}}
					placeholder='{"source":"...","facts":["..."]}'
					size="dense"
					value={
						row.context === undefined
							? ""
							: JSON.stringify(row.context, null, 2)
					}
					variant="code"
				/>
			</div>

			<div className="flex flex-col gap-1">
				<Label htmlFor={`test-threshold-${row.id}`} size="compact">
					Assertion threshold (optional)
				</Label>
				<Input
					id={`test-threshold-${row.id}`}
					inputMode="decimal"
					max="1"
					min="0"
					name={`test-threshold-${row.id}`}
					onChange={(e) => onUpdate(row.id, { threshold: e.target.value })}
					placeholder="1.0 means every assertion must pass"
					size="dense"
					step="0.05"
					type="number"
					value={row.threshold}
				/>
			</div>
			<label className="type-caption flex items-center justify-between gap-2 rounded-md border px-2 py-1">
				<span>
					Inherit suite default test
					<span className="type-compact block text-muted-foreground">
						Disable for a standalone case
					</span>
				</span>
				<Switch
					aria-label={`Inherit default test for case ${index + 1}`}
					checked={row.inheritDefaultTest !== false}
					onCheckedChange={(checked) =>
						onUpdate(row.id, { inheritDefaultTest: checked })
					}
				/>
			</label>

			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
				<div className="flex flex-col gap-1">
					<Label htmlFor={`test-provider-${row.id}`} size="caption">
						Provider override (optional)
					</Label>
					<Input
						id={`test-provider-${row.id}`}
						onChange={(event) =>
							onUpdate(row.id, {
								provider: event.target.value.trim() || undefined,
							})
						}
						placeholder="openai:gpt-4o"
						size="dense"
						value={row.provider ?? ""}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor={`test-provider-output-${row.id}`} size="caption">
						Provider output fixture (optional JSON)
					</Label>
					<Input
						id={`test-provider-output-${row.id}`}
						onChange={(event) =>
							onUpdate(row.id, {
								providerOutput: event.target.value.trim()
									? parseVariable(event.target.value)
									: undefined,
							})
						}
						placeholder='{"choices":[{"message":{"content":"fixture"}}]}'
						size="dense"
						value={
							row.providerOutput === undefined
								? ""
								: displayVariable(row.providerOutput)
						}
						variant="code"
					/>
				</div>
			</div>

			<details className="rounded-md border border-dashed p-2">
				<summary className="type-caption cursor-pointer text-muted-foreground">
					Promptfoo case options (prefix, suffix, transform, timeout, cache)
				</summary>
				<Textarea
					aria-label="Promptfoo case options (JSON)"
					className="mt-2"
					onChange={(event) => {
						try {
							const parsed = parsePromptfooValue(
								JSON.parse(event.target.value)
							);
							if (isRecord(parsed)) {
								onUpdate(row.id, { options: parsed });
							}
						} catch {
							// Keep the last valid object while editing JSON.
						}
					}}
					placeholder='{"prefix":"","suffix":"","transform":"trim","timeout_ms":30000,"cache":true}'
					size="dense"
					value={JSON.stringify(row.options, null, 2)}
					variant="code"
				/>
			</details>

			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
				<div className="flex flex-col gap-1">
					<Label htmlFor={`test-providers-${row.id}`} size="caption">
						Providers (optional, comma-separated)
					</Label>
					<Input
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
						size="dense"
						value={row.providers.join(", ")}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor={`test-metadata-${row.id}`} size="caption">
						Metadata JSON
					</Label>
					<Input
						id={`test-metadata-${row.id}`}
						onChange={(event) => {
							try {
								const parsed = parsePromptfooValue(
									JSON.parse(event.target.value)
								);
								if (isRecord(parsed)) {
									onUpdate(row.id, { metadata: parsed });
								}
							} catch {
								// Keep the last valid object while editing.
							}
						}}
						placeholder='{"team":"support"}'
						size="dense"
						value={JSON.stringify(row.metadata)}
						variant="code"
					/>
				</div>
			</div>

			<div className="flex flex-col gap-2">
				<Label size="compact">Assertions</Label>
				{row.assertions.map((a, idx) => (
					<AssertionEditor
						assertion={a}
						// assertions are positional within a row and have no stable id
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
		"assert_set",
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
			});
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
	} else if (assertion.kind === "latency") {
		placeholder = "Maximum latency in milliseconds";
	} else if (assertion.kind === "cost") {
		placeholder = "Maximum cost in micro-USD";
	} else if (assertion.kind === "assert_set") {
		placeholder = '[{"kind":"contains","value":"expected"}]';
	}

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-2">
				<NativeSelect
					appearance="dense"
					aria-label="Assertion type"
					className="w-36"
					onChange={(e) =>
						handleKindChange(assertionKindSchema.parse(e.target.value))
					}
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
						className="flex-1"
						onChange={(e) => handleTextChange(e.target.value)}
						placeholder={placeholder}
						size="dense"
						value={assertionText(assertion)}
					/>
				) : (
					<span className="flex-1 text-muted-foreground text-xs">
						{assertion.kind === "assert_set"
							? "JSON array of nested assertions."
							: "Passes when the response matches this structural assertion."}
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
			<div className="grid grid-cols-2 gap-1 sm:grid-cols-5">
				<Input
					aria-label="Assertion threshold"
					inputMode="decimal"
					max="1"
					min="0"
					onChange={(event) =>
						updateOptions({ threshold: parseThreshold(event.target.value) })
					}
					placeholder="Threshold"
					size="micro"
					step="0.05"
					type="number"
					value={assertion.options?.threshold ?? ""}
				/>
				<Input
					aria-label="Assertion weight"
					inputMode="decimal"
					min="0"
					onChange={(event) => {
						const parsed = Number.parseFloat(event.target.value);
						updateOptions({
							weight: Number.isFinite(parsed) ? parsed : undefined,
						});
					}}
					placeholder="Weight"
					size="micro"
					step="0.1"
					type="number"
					value={assertion.options?.weight ?? ""}
				/>
				<Input
					aria-label="Assertion provider"
					onChange={(event) =>
						updateOptions({ provider: event.target.value || undefined })
					}
					placeholder="Judge model/provider"
					size="micro"
					value={assertion.options?.provider ?? ""}
				/>
				<Input
					aria-label="Assertion transform"
					onChange={(event) =>
						updateOptions({ transform: event.target.value || undefined })
					}
					placeholder="Transform (exported)"
					size="micro"
					value={assertion.options?.transform ?? ""}
				/>
				<label className="type-compact flex items-center justify-between gap-1 rounded-md border px-2">
					<span>Negate</span>
					<Switch
						aria-label="Negate assertion"
						checked={assertion.options?.not === true}
						onCheckedChange={(checked) => updateOptions({ not: checked })}
					/>
				</label>
			</div>
		</div>
	);
}

// ── Model controls ─────────────────────────────────────────────────────────────

interface ModelControlsProps {
	extraModels: string[];
	judgeModel: string;
	locked: boolean;
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
	locked,
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
					<Badge key={m} trailingAction variant="outline">
						{m}
						<Button
							aria-label={`Remove model ${m}`}
							className="size-4"
							disabled={locked}
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
					<Label htmlFor="ps-add-model" size="caption">
						Add model to compare
					</Label>
					<div className="flex items-center gap-1">
						<Input
							className="w-48"
							disabled={locked}
							id="ps-add-model"
							onChange={(e) => onNewModelChange(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="e.g. claude-3-5-haiku"
							size="dense"
							value={newModel}
						/>
						<Button
							aria-label="Add model"
							disabled={locked}
							onClick={onAddModel}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-3" icon={Add01Icon} />
						</Button>
					</div>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="ps-judge-model" size="caption">
						Judge model (optional)
					</Label>
					<Input
						className="w-48"
						disabled={locked}
						id="ps-judge-model"
						onChange={(e) => onJudgeChange(e.target.value)}
						placeholder="defaults to the first model"
						size="dense"
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
			<span className="text-status-warning text-xs dark:text-status-warning">
				Large matrix — this may be slow and could hit a 120s timeout.
			</span>
		);
	}
	return null;
}

interface PromptScoreWidth extends CSSProperties {
	"--prompt-score-width": string;
}
interface PromptScoreHeight extends CSSProperties {
	"--prompt-score-height": string;
}

// ── Results matrix ─────────────────────────────────────────────────────────────

interface ResultsMatrixProps {
	comparisonResults: PromptVariantRun[] | null;
	comparisonRunId: string | null;
	model: string;
	onReviewSaved: (review: PromptReview) => void;
	results: PromptVariantRun[];
	reviews: Record<string, PromptReview>;
	rows: TestCaseRow[];
	runId: string | null;
	suiteId: string | null;
	target: ApiTarget;
}

type ResultFilter =
	| "all"
	| "pass"
	| "fail"
	| "error"
	| "different"
	| "highlighted";

function matchesMetadataQuery(
	metadataInput: Parameters<typeof parsePromptfooValue>[0],
	query: string
): boolean {
	const metadata = parsePromptfooValue(metadataInput);
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) {
		return true;
	}
	const separatorIndex = normalizedQuery.indexOf("=");
	if (separatorIndex < 0) {
		return JSON.stringify(metadata ?? {})
			.toLowerCase()
			.includes(normalizedQuery);
	}
	if (!isRecord(metadata)) {
		return false;
	}
	const key = normalizedQuery.slice(0, separatorIndex).trim();
	const expectedValue = normalizedQuery.slice(separatorIndex + 1).trim();
	const actual = Object.entries(metadata).find(
		([name]) => name.toLowerCase() === key
	)?.[1];
	if (actual === undefined) {
		return false;
	}
	return JSON.stringify(actual).toLowerCase().includes(expectedValue);
}

interface ResultExportRow {
	caseIndex: number;
	caseName: string;
	model: string;
	prompt: string;
	promptName: string;
	resultKey: string;
	score: EvalCaseScore;
}

function resultModels(
	promptResult: PromptVariantRun,
	fallbackModel: string
): ModelEvalResult[] {
	return (
		promptResult.result.models ?? [
			{
				model: fallbackModel,
				cases: promptResult.result.cases,
				aggregate: promptResult.result.aggregate,
			},
		]
	);
}

function flattenResultRows(
	results: PromptVariantRun[],
	model: string,
	rows: TestCaseRow[]
): ResultExportRow[] {
	const output: ResultExportRow[] = [];
	for (const promptResult of results) {
		for (const entry of resultModels(promptResult, model)) {
			for (const [caseIndex, score] of entry.cases.entries()) {
				output.push({
					caseIndex,
					caseName: rows[caseIndex]?.name || `Case ${caseIndex + 1}`,
					model: entry.model,
					prompt: score.prompt,
					promptName: promptResult.promptName,
					resultKey: `${promptResult.promptId}:${entry.model}:${caseIndex}`,
					score,
				});
			}
		}
	}
	return output;
}

function exportRowsCsv(rows: ResultExportRow[]): string {
	const cell = (input: Parameters<typeof parsePromptfooValue>[0]): string => {
		const value = parsePromptfooValue(input);
		const text = isString(value) ? value : JSON.stringify(value ?? "");
		return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
	};
	return [
		"prompt,model,case,overall,assertion_score,assertions_pass,error,response,latency_score,latency_available,policy_available,input_tokens,output_tokens,cost_micro_usd,metadata",
		...rows.map(({ caseName, model, promptName, score }) =>
			[
				promptName,
				model,
				caseName,
				score.overall,
				score.assertion_score,
				score.assertions_pass,
				score.error ?? "",
				score.response_text,
				score.latency_score,
				score.latency_available ?? true,
				score.policy_available ?? true,
				score.input_tokens ?? "",
				score.output_tokens ?? "",
				score.cost_micro_usd ?? "",
				score.metadata ?? {},
			]
				.map(cell)
				.join(",")
		),
	].join("\n");
}

function exportDpoJsonl(rows: ResultExportRow[]): string {
	const byPromptAndCase = new Map<string, ResultExportRow[]>();
	for (const row of rows) {
		const key = `${row.promptName}:${row.caseIndex}`;
		const group = byPromptAndCase.get(key) ?? [];
		group.push(row);
		byPromptAndCase.set(key, group);
	}
	const preferences: PromptfooDocument[] = [];
	for (const group of byPromptAndCase.values()) {
		if (group.length < 2) {
			continue;
		}
		const ranked = [...group].sort(
			(left, right) => right.score.overall - left.score.overall
		);
		const chosen = ranked[0];
		const rejected = ranked.at(-1);
		if (!(chosen && rejected) || chosen.model === rejected.model) {
			continue;
		}
		preferences.push({
			chosen: chosen.score.response_text,
			chosen_model: chosen.model,
			metadata: parsePromptfooDocument(chosen.score.metadata ?? {}),
			prompt: chosen.prompt,
			rejected: rejected.score.response_text,
			rejected_model: rejected.model,
		});
	}
	return preferences.map((row) => JSON.stringify(row)).join("\n");
}

function exportHumanEvalYaml(
	rows: ResultExportRow[],
	reviews: Record<string, PromptReview>
): string {
	return stringifyYaml(
		rows.map(({ caseName, model, prompt, promptName, resultKey, score }) => {
			const review = reviews[resultKey];
			return {
				case: caseName,
				comment: review?.comment ?? null,
				highlighted: review?.highlighted ?? false,
				input: prompt,
				model,
				output: score.response_text,
				pass: review?.pass ?? null,
				prompt: promptName,
				score: review?.score ?? score.overall,
			};
		})
	);
}

function ResultsMatrix({
	comparisonResults,
	comparisonRunId,
	model,
	onReviewSaved,
	results,
	reviews,
	rows,
	runId,
	suiteId,
	target,
}: ResultsMatrixProps) {
	const [filter, setFilter] = useState<ResultFilter>("all");
	const [query, setQuery] = useState("");
	const [metadataQuery, setMetadataQuery] = useState("");
	const [regexQuery, setRegexQuery] = useState(false);
	const [exportFormat, setExportFormat] = useState<
		"csv" | "json" | "yaml" | "failed_json" | "dpo_jsonl" | "human_yaml"
	>("json");
	const [copyMessage, setCopyMessage] = useState<string | null>(null);
	useEffect(() => {
		if (globalThis.window === undefined) {
			return;
		}
		const queryString = window.location.hash.split("?")[1];
		if (!queryString) {
			return;
		}
		const params = new URLSearchParams(queryString);
		const linkedFilter = params.get("filter");
		if (
			linkedFilter &&
			["all", "pass", "fail", "error", "different", "highlighted"].includes(
				linkedFilter
			)
		) {
			setFilter(resultFilterSchema.parse(linkedFilter));
		}
		setQuery(params.get("q") ?? "");
		setMetadataQuery(params.get("metadata") ?? "");
		setRegexQuery(params.get("regex") === "1");
	}, []);

	useEffect(() => {
		if (globalThis.window === undefined) {
			return;
		}
		const params = new URLSearchParams();
		if (runId) {
			params.set("run_id", runId);
		}
		if (filter !== "all") {
			params.set("filter", filter);
		}
		if (query) {
			params.set("q", query);
		}
		if (metadataQuery) {
			params.set("metadata", metadataQuery);
		}
		if (regexQuery) {
			params.set("regex", "1");
		}
		const hash = params.size > 0 ? `#promptfoo-results?${params}` : "";
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${window.location.search}${hash}`
		);
	}, [filter, metadataQuery, query, regexQuery, runId]);
	const exportRows = useMemo(
		() => flattenResultRows(results, model, rows),
		[model, results, rows]
	);
	const isDifferent = useCallback(
		(promptResult: PromptVariantRun, caseIndex: number) => {
			const outputs = resultModels(promptResult, model)
				.map((entry) => entry.cases[caseIndex]?.response_text)
				.filter((value): value is string => value !== undefined);
			return new Set(outputs).size > 1;
		},
		[model]
	);
	const matches = useCallback(
		(
			promptResult: PromptVariantRun,
			entry: ModelEvalResult,
			caseIndex: number,
			score: EvalCaseScore | undefined
		) => {
			if (!score) {
				return false;
			}
			const resultKey = `${promptResult.promptId}:${entry.model}:${caseIndex}`;
			const row = rows[caseIndex];
			const haystack = JSON.stringify({
				case: row?.name,
				metadata: score.metadata ?? row?.metadata,
				model: entry.model,
				prompt: score.prompt,
				response: score.response_text,
			});
			if (query.trim()) {
				if (regexQuery) {
					try {
						if (!new RegExp(query, "i").test(haystack)) {
							return false;
						}
					} catch {
						return false;
					}
				} else if (
					!haystack.toLowerCase().includes(query.trim().toLowerCase())
				) {
					return false;
				}
			}
			if (
				metadataQuery.trim() &&
				!matchesMetadataQuery(
					score.metadata ?? row?.metadata ?? {},
					metadataQuery
				)
			) {
				return false;
			}
			if (filter === "pass" && !score.assertions_pass) {
				return false;
			}
			if (filter === "fail" && (score.assertions_pass || score.error)) {
				return false;
			}
			if (filter === "error" && !score.error) {
				return false;
			}
			if (filter === "different" && !isDifferent(promptResult, caseIndex)) {
				return false;
			}
			if (filter === "highlighted" && !reviews[resultKey]?.highlighted) {
				return false;
			}
			return true;
		},
		[filter, isDifferent, metadataQuery, query, regexQuery, reviews, rows]
	);

	const copy = useCallback(async (text: string) => {
		if (!navigator.clipboard) {
			return;
		}
		await navigator.clipboard.writeText(text);
		setCopyMessage("Copied");
		window.setTimeout(() => setCopyMessage(null), 1500);
	}, []);

	const downloadResults = () => {
		const filteredRows = exportRows.filter((row) => {
			const promptResult = results.find(
				(result) => result.promptId === row.resultKey.split(":")[0]
			);
			const entry = promptResult
				? resultModels(promptResult, model).find(
						(candidate) => candidate.model === row.model
					)
				: undefined;
			return promptResult && entry
				? matches(promptResult, entry, row.caseIndex, row.score)
				: false;
		});
		let text: string;
		let extension = exportFormat;
		if (exportFormat === "csv") {
			text = exportRowsCsv(filteredRows);
		} else if (exportFormat === "yaml") {
			text = stringifyYaml(filteredRows.map((row) => row.score));
		} else if (exportFormat === "failed_json") {
			text = JSON.stringify(
				filteredRows.filter(
					(row) => !row.score.assertions_pass || row.score.error
				),
				null,
				2
			);
			extension = "json";
		} else if (exportFormat === "dpo_jsonl") {
			text = exportDpoJsonl(filteredRows);
		} else if (exportFormat === "human_yaml") {
			text = exportHumanEvalYaml(filteredRows, reviews);
			extension = "yaml";
		} else {
			text = JSON.stringify(filteredRows, null, 2);
		}
		const link = document.createElement("a");
		const url = URL.createObjectURL(
			new Blob([text], {
				type:
					exportFormat === "csv"
						? "text/csv"
						: exportFormat === "yaml" || exportFormat === "human_yaml"
							? "text/yaml"
							: "application/json",
			})
		);
		link.href = url;
		link.download = `promptfoo-results.${extension}`;
		link.click();
		URL.revokeObjectURL(url);
	};

	const visibleCount = results.reduce(
		(total, promptResult) =>
			total +
			resultModels(promptResult, model).reduce(
				(entryTotal, entry) =>
					entryTotal +
					entry.cases.filter((score, caseIndex) =>
						matches(promptResult, entry, caseIndex, score)
					).length,
				0
			),
		0
	);
	const runMean = useMemo(() => {
		const values = results.flatMap((result) =>
			resultModels(result, model).map((entry) => entry.aggregate.mean_overall)
		);
		return values.length > 0
			? values.reduce((sum, value) => sum + value, 0) / values.length
			: 0;
	}, [model, results]);
	const comparisonMean = useMemo(() => {
		if (!comparisonResults) {
			return null;
		}
		const values = comparisonResults.flatMap((result) =>
			resultModels(result, model).map((entry) => entry.aggregate.mean_overall)
		);
		return values.length > 0
			? values.reduce((sum, value) => sum + value, 0) / values.length
			: 0;
	}, [comparisonResults, model]);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-2 rounded-lg bg-muted/20 p-3">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium text-xs">Results matrix</span>
					<Badge variant="outline">{visibleCount} visible cells</Badge>
					<span className="type-compact text-muted-foreground">
						Search, facet, review, compare, and export this run.
					</span>
				</div>
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
					<Input
						aria-label="Search result matrix"
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search cases, prompts, outputs, models"
						size="dense"
						value={query}
					/>
					<Input
						aria-label="Filter result metadata"
						onChange={(event) => setMetadataQuery(event.target.value)}
						placeholder="Metadata facet, e.g. team=support"
						size="dense"
						value={metadataQuery}
					/>
					<label className="type-compact flex items-center justify-between gap-2 rounded-md border px-2">
						<span>Regex search</span>
						<Switch
							aria-label="Regex result search"
							checked={regexQuery}
							onCheckedChange={setRegexQuery}
						/>
					</label>
					<NativeSelect
						appearance="dense"
						aria-label="Result matrix filter"
						onChange={(event) =>
							setFilter(resultFilterSchema.parse(event.target.value))
						}
						value={filter}
					>
						<NativeSelectOption value="all">All cells</NativeSelectOption>
						<NativeSelectOption value="pass">Passing</NativeSelectOption>
						<NativeSelectOption value="fail">Failing</NativeSelectOption>
						<NativeSelectOption value="error">Errors</NativeSelectOption>
						<NativeSelectOption value="different">
							Different outputs
						</NativeSelectOption>
						<NativeSelectOption value="highlighted">
							Human highlighted
						</NativeSelectOption>
					</NativeSelect>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<NativeSelect
						appearance="dense"
						aria-label="Results export format"
						className="w-40"
						onChange={(event) =>
							setExportFormat(
								z
									.enum([
										"yaml",
										"json",
										"csv",
										"failed_json",
										"dpo_jsonl",
										"human_yaml",
									])
									.parse(event.target.value)
							)
						}
						value={exportFormat}
					>
						<NativeSelectOption value="json">JSON</NativeSelectOption>
						<NativeSelectOption value="yaml">YAML</NativeSelectOption>
						<NativeSelectOption value="csv">CSV</NativeSelectOption>
						<NativeSelectOption value="failed_json">
							Failed only (JSON)
						</NativeSelectOption>
						<NativeSelectOption value="dpo_jsonl">
							DPO preferences (JSONL)
						</NativeSelectOption>
						<NativeSelectOption value="human_yaml">
							Human eval (YAML)
						</NativeSelectOption>
					</NativeSelect>
					<Button onClick={downloadResults} size="sm" variant="outline">
						Export selected
					</Button>
					{copyMessage ? (
						<span className="text-status-success text-xs" role="status">
							{copyMessage}
						</span>
					) : null}
				</div>
			</div>
			{comparisonResults && comparisonMean !== null ? (
				<div className="flex flex-col gap-2 rounded-lg border border-dashed bg-muted/10 p-3">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-medium text-xs">Run comparison</span>
						<Badge variant="outline">vs {comparisonRunId}</Badge>
					</div>
					<div className="grid grid-cols-2 gap-3 text-xs">
						<div className="flex flex-col gap-1">
							<span className="text-muted-foreground">Current run</span>
							<div className="h-2 overflow-hidden rounded-full bg-muted">
								<div
									className="h-full w-(--prompt-score-width) rounded-full bg-primary"
									style={
										/* SAFETY: React forwards CSS custom properties; this typed literal contains only a percentage string. */ {
											"--prompt-score-width": `${Math.round(runMean * 100)}%`,
										} as PromptScoreWidth
									}
								/>
							</div>
							<span className="font-medium">{pct(runMean)}</span>
						</div>
						<div className="flex flex-col gap-1">
							<span className="text-muted-foreground">Compared run</span>
							<div className="h-2 overflow-hidden rounded-full bg-muted">
								<div
									className="h-full w-(--prompt-score-width) rounded-full bg-secondary-foreground"
									style={
										/* SAFETY: React forwards CSS custom properties; this typed literal contains only a percentage string. */ {
											"--prompt-score-width": `${Math.round(comparisonMean * 100)}%`,
										} as PromptScoreWidth
									}
								/>
							</div>
							<span className="font-medium">{pct(comparisonMean)}</span>
						</div>
					</div>
				</div>
			) : null}
			{results.map((promptResult) => {
				// Back-compat read path: single-model responses have no `models` key.
				const models = resultModels(promptResult, model);
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
						<div className="flex flex-col gap-1 rounded-lg border bg-muted/10 p-2">
							<span className="type-compact text-muted-foreground uppercase tracking-wide">
								Quality by model
							</span>
							{models.map((entry) => (
								<div
									className="flex items-center gap-2"
									key={`bar-${entry.model}`}
								>
									<span
										className="type-compact w-28 truncate"
										title={entry.model}
									>
										{entry.model}
									</span>
									<div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
										<div
											className="h-full w-(--prompt-score-width) rounded-full bg-primary"
											style={
												/* SAFETY: React forwards CSS custom properties; this typed literal contains only a percentage string. */ {
													"--prompt-score-width": `${Math.round(entry.aggregate.mean_overall * 100)}%`,
												} as PromptScoreWidth
											}
										/>
									</div>
									<span className="type-compact w-10 text-right tabular-nums">
										{pct(entry.aggregate.mean_overall)}
									</span>
								</div>
							))}
						</div>
						<div className="flex flex-col gap-1 rounded-lg border bg-muted/10 p-2">
							<span className="type-compact text-muted-foreground uppercase tracking-wide">
								Score distribution
							</span>
							{(() => {
								const buckets = [0, 0, 0, 0];
								for (const entry of models) {
									for (const score of entry.cases) {
										const bucket = Math.min(3, Math.floor(score.overall * 4));
										buckets[bucket] = (buckets[bucket] ?? 0) + 1;
									}
								}
								const maximum = Math.max(...buckets, 1);
								return (
									<div className="grid grid-cols-4 gap-2">
										{buckets.map((count, index) => (
											<div
												className="flex flex-col gap-1"
												key={`bucket-${index}`}
											>
												<div className="flex h-8 items-end rounded bg-muted">
													<div
														className="h-(--prompt-score-height) w-full rounded bg-primary/70"
														style={
															/* SAFETY: React forwards CSS custom properties; this typed literal contains only a percentage string. */ {
																"--prompt-score-height": `${Math.max(4, (count / maximum) * 100)}%`,
															} as PromptScoreHeight
														}
													/>
												</div>
												<span className="type-micro text-center text-muted-foreground">
													{index * 25}–{index === 3 ? 100 : (index + 1) * 25}% ·{" "}
													{count}
												</span>
											</div>
										))}
									</div>
								);
							})()}
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
									{caseIndices.map((idx) => {
										const visible = models.some((entry) =>
											matches(promptResult, entry, idx, entry.cases[idx])
										);
										if (!visible) {
											return null;
										}
										return (
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
															onCopy={copy}
															onReviewSaved={onReviewSaved}
															resultKey={`${promptResult.promptId}:${entry.model}:${idx}`}
															review={
																reviews[
																	`${promptResult.promptId}:${entry.model}:${idx}`
																]
															}
															runId={runId}
															score={entry.cases[idx]}
															suiteId={suiteId}
															target={target}
														/>
													</td>
												))}
											</tr>
										);
									})}
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
			<div className="grid grid-cols-2 gap-1 sm:grid-cols-5">
				<StatCell
					label="Overall"
					tone={scoreTone(agg.mean_overall)}
					value={pct(agg.mean_overall)}
				/>
				<StatCell
					label="Policy"
					value={
						agg.policy_available_cases === 0 ? "N/A" : pct(agg.policy_pass_rate)
					}
				/>
				<StatCell
					label="Assert"
					tone={scoreTone(assertionRate)}
					value={pct(assertionRate)}
				/>
				<StatCell
					label="Tokens"
					value={String(
						(agg.total_input_tokens ?? 0) + (agg.total_output_tokens ?? 0)
					)}
				/>
				<StatCell
					label="Spend"
					value={formatMicroUsd(agg.total_cost_micro_usd)}
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
			<span className="type-micro text-muted-foreground uppercase tracking-wide">
				{label}
			</span>
			<span className={`font-medium text-xs ${tone ?? ""}`}>{value}</span>
		</div>
	);
}

function jsonOutput(text: string): string {
	try {
		return JSON.stringify(parsePromptfooValue(JSON.parse(text)), null, 2);
	} catch {
		return text;
	}
}

function MatrixCell({
	resultKey,
	runId,
	review: persistedReview,
	onCopy,
	onReviewSaved,
	score,
	suiteId,
	target,
}: {
	resultKey: string;
	runId: string | null;
	review?: PromptReview;
	onCopy: (text: string) => Promise<void>;
	onReviewSaved: (review: PromptReview) => void;
	score: EvalCaseScore | undefined;
	suiteId: string | null;
	target: ApiTarget;
}) {
	const [reviewSaving, setReviewSaving] = useState(false);
	const [reviewed, setReviewed] = useState<boolean | null>(
		persistedReview?.pass ?? null
	);
	const [reviewComment, setReviewComment] = useState(
		persistedReview?.comment ?? ""
	);
	const [reviewHighlighted, setReviewHighlighted] = useState(
		persistedReview?.highlighted ?? false
	);
	const [reviewScore, setReviewScore] = useState(
		persistedReview?.score === null || persistedReview?.score === undefined
			? ""
			: String(persistedReview.score)
	);
	const [renderMode, setRenderMode] = useState<"text" | "markdown" | "json">(
		"text"
	);

	useEffect(() => {
		setReviewed(persistedReview?.pass ?? null);
		setReviewComment(persistedReview?.comment ?? "");
		setReviewHighlighted(persistedReview?.highlighted ?? false);
		setReviewScore(
			persistedReview?.score === null || persistedReview?.score === undefined
				? ""
				: String(persistedReview.score)
		);
	}, [persistedReview]);
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
			const parsedReviewScore = Number.parseFloat(reviewScore);
			const savedReview = await savePromptReview(target, suiteId, runId, {
				comment: reviewComment.trim() || undefined,
				highlighted: options.highlighted ?? reviewHighlighted,
				pass,
				resultKey,
				score: Number.isFinite(parsedReviewScore)
					? Math.max(0, Math.min(1, parsedReviewScore))
					: score.overall,
			});
			setReviewed(pass);
			setReviewScore(String(savedReview.score ?? score.overall));
			onReviewSaved(savedReview);
		} catch (error) {
			toastActionError("Couldn't save review", error);
		} finally {
			setReviewSaving(false);
		}
	};
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex flex-wrap items-center gap-1">
				<Badge
					size="compact"
					tone={score.assertions_pass ? "default" : "destructive"}
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
							className={`type-compact rounded px-1 py-0.5 ${evaluator.pass ? "bg-success/15 text-status-success dark:text-status-success" : "bg-warning/15 text-status-warning dark:text-status-warning"}`}
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
			<details className="type-compact rounded border border-dashed px-2 py-1">
				<summary className="cursor-pointer text-muted-foreground">
					Inspect full cell
				</summary>
				<div className="mt-2 flex flex-col gap-1">
					<div className="flex items-center justify-between gap-2">
						<span className="text-muted-foreground">Rendered prompt</span>
						<Button
							onClick={() => onCopy(score.rendered_prompt ?? score.prompt)}
							size="micro"
							variant="ghost"
						>
							<HugeiconsIcon className="size-3" icon={Copy01Icon} />
							Copy
						</Button>
					</div>
					<pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-1">
						{score.rendered_prompt ?? score.prompt}
					</pre>
					<div className="flex items-center justify-between gap-2">
						<span className="text-muted-foreground">Full output</span>
						<Button
							onClick={() => onCopy(score.response_text)}
							size="micro"
							variant="ghost"
						>
							<HugeiconsIcon className="size-3" icon={Copy01Icon} />
							Copy
						</Button>
					</div>
					<NativeSelect
						appearance="micro-dense"
						aria-label="Cell output render mode"
						className="w-28"
						onChange={(event) =>
							setRenderMode(
								z.enum(["text", "markdown", "json"]).parse(event.target.value)
							)
						}
						value={renderMode}
					>
						<NativeSelectOption value="text">Text</NativeSelectOption>
						<NativeSelectOption value="markdown">Markdown</NativeSelectOption>
						<NativeSelectOption value="json">JSON</NativeSelectOption>
					</NativeSelect>
					{renderMode === "markdown" ? (
						<div className="max-h-40 overflow-auto rounded bg-muted/30 p-1">
							<Markdown
								className="text-xs [&_p]:my-1"
								content={score.response_text}
							/>
						</div>
					) : (
						<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-1">
							{renderMode === "json"
								? jsonOutput(score.response_text)
								: score.response_text}
						</pre>
					)}
					<div className="grid grid-cols-2 gap-1 text-muted-foreground">
						<span>
							Latency score:{" "}
							{score.latency_available === false
								? "N/A"
								: pct(score.latency_score)}
						</span>
						<span>Tokens: {score.total_tokens ?? "—"}</span>
						<span>Cost: {score.cost_micro_usd ?? "unknown"}µUSD</span>
						<span>Cache: {score.cache_hit ? "hit" : "miss"}</span>
					</div>
					{score.error ? (
						<p className="text-status-destructive">{score.error}</p>
					) : null}
					<pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-1">
						{JSON.stringify(score.metadata ?? {}, null, 2)}
					</pre>
					{score.context === undefined ? null : (
						<pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-1">
							{JSON.stringify(score.context, null, 2)}
						</pre>
					)}
				</div>
			</details>
			{runId && suiteId ? (
				<div className="flex items-center gap-1">
					<span className="type-compact mr-1 text-muted-foreground">
						Review
					</span>
					<Button
						disabled={reviewSaving}
						onClick={() => review(true).catch(() => undefined)}
						size="micro"
						variant={reviewed === true ? "secondary" : "ghost"}
					>
						Pass
					</Button>
					<Button
						disabled={reviewSaving}
						onClick={() => review(false).catch(() => undefined)}
						size="micro"
						variant={reviewed === false ? "destructive" : "ghost"}
					>
						Fail
					</Button>
					<Button
						disabled={reviewSaving}
						onClick={() => {
							const next = !reviewHighlighted;
							setReviewHighlighted(next);
							review(reviewed ?? score.assertions_pass, {
								highlighted: next,
							}).catch(() => undefined);
						}}
						size="micro"
						variant={reviewHighlighted ? "secondary" : "ghost"}
					>
						{reviewHighlighted ? "Highlighted" : "Highlight"}
					</Button>
					<Input
						aria-label="Human review score"
						className="w-16"
						disabled={reviewSaving}
						max="1"
						min="0"
						onChange={(event) => setReviewScore(event.target.value)}
						placeholder="0–1"
						size="micro"
						step="0.05"
						type="number"
						value={reviewScore}
					/>
					<Input
						aria-label="Human review comment"
						disabled={reviewSaving}
						onChange={(event) => setReviewComment(event.target.value)}
						placeholder="Add a review comment…"
						size="micro"
						value={reviewComment}
					/>
					<Button
						className="self-start"
						disabled={reviewSaving || !reviewComment.trim()}
						onClick={() =>
							review(reviewed ?? score.assertions_pass).catch(() => undefined)
						}
						size="micro"
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
				const className = `rounded px-1 py-0.5 type-compact ${a.pass ? "bg-success/15 text-status-success dark:text-status-success" : "bg-destructive/15 text-status-destructive"}`;
				return a.detail ? (
					<Tooltip
						// assertion results are positional and have no stable id
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
						// assertion results are positional and have no stable id
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

	const { messages, sendMessage, status, error, stop } = useChat({
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
	const sentConversationRef = useRef<string | null>(null);
	useEffect(() => {
		if (sentConversationRef.current === convId) {
			return;
		}
		sentConversationRef.current = convId;
		// Opening Preview prompt is the user action that starts this ephemeral
		// conversation. Showing a fabricated user message alone left the panel
		// permanently at "No response yet" without sending anything to Core.
		void sendMessage({ text: previewMessage });
	}, [convId, previewMessage, sendMessage]);

	const isStreaming = status === "streaming" || status === "submitted";
	// Core keeps the saved preview turn running after its stream is aborted, so
	// Stop also cancels it there.
	const stopPreview = useCallback(() => {
		void stop();
		cancelChat(target, convId).catch(() => {
			// No live turn, or Core is unreachable; the abort above still stands.
		});
	}, [convId, stop, target]);

	const assistantMessages = messages.filter((m) => m.role === "assistant");
	const lastAssistant = assistantMessages.at(-1);

	const responseText =
		lastAssistant?.parts
			.filter((p) => p.type === "text")
			.map((part) => part.text)
			.join("") ?? "";

	return (
		<div className="flex flex-col gap-3 rounded-lg bg-card p-4">
			<div className="flex items-center gap-2">
				<span className="font-medium text-sm">Preview response</span>
				{isStreaming ? (
					<Badge className="ml-auto" motion="pulse" variant="secondary">
						Streaming…
					</Badge>
				) : null}
				{isStreaming ? (
					<Button
						aria-label="Stop preview response"
						onClick={stopPreview}
						size="icon-sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-3" icon={Square01Icon} />
					</Button>
				) : null}
			</div>

			{error ? (
				<p className="text-status-destructive text-xs">{error.message}</p>
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
