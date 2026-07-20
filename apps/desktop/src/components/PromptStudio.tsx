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
// with per-assertion pass/fail chips. Client-side prompt version history is kept
// in localStorage keyed by agentId.

import { useChat } from "@ai-sdk/react";
import {
	Add01Icon,
	Cancel01Icon,
	Clock01Icon,
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
import { Spinner } from "@ryu/ui/components/spinner";
import { Textarea } from "@ryu/ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownEditor } from "@/src/components/editor/MarkdownEditor.tsx";
import { chatHeaders, chatStreamUrl } from "@/src/lib/api/chat.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type Assertion,
	type AssertionResult,
	type EvalCaseScore,
	type EvalDatasetCase,
	type EvalRunResult,
	type ModelEvalResult,
	runGatewayEvals,
} from "@/src/lib/api/gateway.ts";

// ── Variable placeholder detection ────────────────────────────────────────────
// Named placeholders in {{variable_name}} syntax. A top-level regex (not created
// inside a loop) per the code standards.
const PLACEHOLDER_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

// Large-matrix warning threshold (models × cases). Multi-model × llm_judge fans
// out to sequential provider calls under Core's 120s proxy timeout.
const LARGE_MATRIX_THRESHOLD = 12;
// Cap on stored client-side prompt snapshots; oldest are dropped.
const MAX_SNAPSHOTS = 20;

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

// ── Assertion kinds (UI metadata) ──────────────────────────────────────────────

const ASSERTION_KINDS = [
	"contains",
	"not_contains",
	"equals",
	"regex",
	"json_valid",
	"llm_judge",
] as const;

type AssertionKind = (typeof ASSERTION_KINDS)[number];

const ASSERTION_LABELS: Record<AssertionKind, string> = {
	contains: "Contains",
	not_contains: "Not contains",
	equals: "Equals",
	regex: "Regex",
	json_valid: "Valid JSON",
	llm_judge: "LLM judge",
};

/** Build a default assertion object for a given kind. */
function defaultAssertion(kind: AssertionKind): Assertion {
	if (kind === "json_valid") {
		return { kind: "json_valid" };
	}
	if (kind === "llm_judge") {
		return { kind: "llm_judge", rubric: "" };
	}
	return { kind, value: "" };
}

/** The editable text payload of an assertion (value or rubric), if any. */
function assertionText(a: Assertion): string {
	if (a.kind === "json_valid") {
		return "";
	}
	if (a.kind === "llm_judge") {
		return a.rubric;
	}
	return a.value;
}

/** Set the editable text payload of an assertion, preserving kind. */
function withAssertionText(a: Assertion, text: string): Assertion {
	if (a.kind === "json_valid") {
		return a;
	}
	if (a.kind === "llm_judge") {
		return { kind: "llm_judge", rubric: text };
	}
	return { kind: a.kind, value: text };
}

// ── Test-case rows ─────────────────────────────────────────────────────────────

interface TestCaseRow {
	assertions: Assertion[];
	/** Legacy convenience expected substring. */
	expected: string;
	id: string;
	/** User message; may contain {{vars}}. */
	input: string;
	name: string;
	vars: Record<string, string>;
}

function newTestCaseRow(): TestCaseRow {
	return {
		id: crypto.randomUUID(),
		name: "",
		input: "",
		vars: {},
		expected: "",
		assertions: [],
	};
}

// ── Client-side prompt version history (localStorage, keyed by agentId) ─────────

interface PromptSnapshot {
	id: string;
	ts: number;
	value: string;
	version: string;
}

function historyKey(agentId: string): string {
	return `prompt-studio-versions:${agentId}`;
}

function loadSnapshots(agentId: string | null): PromptSnapshot[] {
	if (agentId === null) {
		return [];
	}
	try {
		const raw = localStorage.getItem(historyKey(agentId));
		if (!raw) {
			return [];
		}
		const parsed = JSON.parse(raw) as PromptSnapshot[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function persistSnapshots(agentId: string, snapshots: PromptSnapshot[]): void {
	try {
		localStorage.setItem(historyKey(agentId), JSON.stringify(snapshots));
	} catch {
		// localStorage may be unavailable/full — history is best-effort.
	}
}

// ── Props ──────────────────────────────────────────────────────────────────────

export interface PromptStudioProps {
	/** The agent id used to send the preview chat request. */
	agentId: string | null;
	/** When true, all editing is disabled. Shows a locked affordance. */
	locked: boolean;
	/**
	 * The agent's chatModel — the model used for eval/test runs. Defaults to "".
	 *
	 * NOTE: until the call site (AgentEditPage) wires `model={chatModel}`, this is
	 * "" and the Test-cases Run button is disabled. That one-line wire is a
	 * separate task and is intentionally not done here.
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
}: PromptStudioProps) {
	// Variable values entered by the user for the preview substitution.
	const [varValues, setVarValues] = useState<Record<string, string>>({});
	// Whether the preview panel is open.
	const [previewOpen, setPreviewOpen] = useState(false);
	// A stable, ephemeral conversation id per preview session so Core doesn't
	// accumulate junk conversation rows across many preview runs.
	const previewConvIdRef = useRef<string>(`preview-${crypto.randomUUID()}`);

	const placeholders = useMemo(() => extractPlaceholders(value), [value]);

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
				<span className="font-semibold text-base">Prompt Studio</span>
				<Badge className="ml-1 text-[10px]" variant="secondary">
					v{version}
				</Badge>
				<div className="ml-auto flex items-center gap-2">
					<PromptHistory
						agentId={agentId}
						currentValue={value}
						locked={locked}
						onRestore={onChange}
						version={version}
					/>
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
									className="h-8 text-xs"
									id={`var-${name}`}
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
				locked={locked}
				model={model}
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

// ── Prompt version history (localStorage) ───────────────────────────────────────

interface PromptHistoryProps {
	agentId: string | null;
	currentValue: string;
	locked: boolean;
	onRestore: (value: string) => void;
	version: string;
}

function PromptHistory({
	agentId,
	currentValue,
	version,
	locked,
	onRestore,
}: PromptHistoryProps) {
	const [open, setOpen] = useState(false);
	const [snapshots, setSnapshots] = useState<PromptSnapshot[]>(() =>
		loadSnapshots(agentId)
	);
	const [diffId, setDiffId] = useState<string | null>(null);

	// Reload snapshots when the agent changes (history is per-agent).
	useEffect(() => {
		setSnapshots(loadSnapshots(agentId));
		setDiffId(null);
	}, [agentId]);

	const handleSnapshot = useCallback(() => {
		if (agentId === null) {
			return;
		}
		const snap: PromptSnapshot = {
			id: crypto.randomUUID(),
			ts: Date.now(),
			version,
			value: currentValue,
		};
		setSnapshots((prev) => {
			const next = [snap, ...prev].slice(0, MAX_SNAPSHOTS);
			persistSnapshots(agentId, next);
			return next;
		});
	}, [agentId, currentValue, version]);

	const handleRestore = useCallback(
		(snap: PromptSnapshot) => {
			onRestore(snap.value);
			setOpen(false);
		},
		[onRestore]
	);

	const handleToggleDiff = useCallback((id: string) => {
		setDiffId((prev) => (prev === id ? null : id));
	}, []);

	if (agentId === null) {
		return null;
	}

	return (
		<div className="relative">
			<div className="flex items-center gap-1">
				{locked ? null : (
					<Button
						className="text-xs"
						onClick={handleSnapshot}
						size="sm"
						variant="ghost"
					>
						Save snapshot
					</Button>
				)}
				<Button
					className="text-xs"
					onClick={() => setOpen((p) => !p)}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3" icon={Clock01Icon} />
					History
					{snapshots.length > 0 ? (
						<Badge className="ml-1 text-[10px]" variant="secondary">
							{snapshots.length}
						</Badge>
					) : null}
				</Button>
			</div>

			{open ? (
				<div className="absolute right-0 z-20 mt-1 max-h-96 w-80 overflow-auto rounded-lg bg-popover p-2 shadow-md">
					{snapshots.length === 0 ? (
						<p className="p-2 text-muted-foreground text-xs">
							No snapshots yet. Save one to keep a history of this prompt.
						</p>
					) : (
						<ul className="flex flex-col gap-1">
							{snapshots.map((snap) => (
								<li
									className="flex flex-col gap-1 rounded-md border p-2"
									key={snap.id}
								>
									<div className="flex items-center gap-2">
										<Badge className="text-[10px]" variant="secondary">
											v{snap.version}
										</Badge>
										<span className="text-muted-foreground text-xs">
											{new Date(snap.ts).toLocaleString()}
										</span>
										<div className="ml-auto flex items-center gap-1">
											<Button
												className="text-[11px]"
												onClick={() => handleToggleDiff(snap.id)}
												size="sm"
												variant="ghost"
											>
												Diff
											</Button>
											{locked ? null : (
												<Button
													className="text-[11px]"
													onClick={() => handleRestore(snap)}
													size="sm"
													variant="ghost"
												>
													Restore
												</Button>
											)}
										</div>
									</div>
									{diffId === snap.id ? (
										<SnapshotDiff
											current={currentValue}
											snapshot={snap.value}
										/>
									) : null}
								</li>
							))}
						</ul>
					)}
				</div>
			) : null}
		</div>
	);
}

/** A simple per-line diff view between a snapshot and the current draft. */
function SnapshotDiff({
	snapshot,
	current,
}: {
	snapshot: string;
	current: string;
}) {
	const snapLines = snapshot.split("\n");
	const curLines = current.split("\n");
	const max = Math.max(snapLines.length, curLines.length);
	const rows: { id: string; tone: string; text: string }[] = [];
	for (let i = 0; i < max; i++) {
		const s = snapLines[i];
		const c = curLines[i];
		if (s === c) {
			rows.push({
				id: `eq-${i}`,
				tone: "text-muted-foreground",
				text: ` ${s ?? ""}`,
			});
		} else {
			if (s !== undefined) {
				rows.push({
					id: `del-${i}`,
					tone: "text-destructive",
					text: `- ${s}`,
				});
			}
			if (c !== undefined) {
				rows.push({
					id: `add-${i}`,
					tone: "text-success dark:text-success",
					text: `+ ${c}`,
				});
			}
		}
	}
	return (
		<pre className="max-h-48 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
			{rows.map((r) => (
				<div className={r.tone} key={r.id}>
					{r.text}
				</div>
			))}
		</pre>
	);
}

// ── Test-cases runner ──────────────────────────────────────────────────────────

interface PromptTestCasesProps {
	agentId: string | null;
	locked: boolean;
	model: string;
	promptDraft: string;
	target: ApiTarget;
}

function PromptTestCases({
	promptDraft,
	agentId,
	target,
	model,
	locked,
}: PromptTestCasesProps) {
	const [rows, setRows] = useState<TestCaseRow[]>([]);
	const [extraModels, setExtraModels] = useState<string[]>([]);
	const [newModel, setNewModel] = useState("");
	const [judgeModel, setJudgeModel] = useState("");
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<EvalRunResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => () => abortRef.current?.abort(), []);

	// The full model list for this run: the agent's model plus any extras.
	const selectedModels = useMemo(() => {
		const all = [model, ...extraModels].map((m) => m.trim()).filter(Boolean);
		return Array.from(new Set(all));
	}, [model, extraModels]);

	const isAcp = model.startsWith("acp:");
	const matrixSize = selectedModels.length * Math.max(rows.length, 1);
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
				prompt: r.input,
				vars: r.vars,
				assertions: r.assertions,
				expected: r.expected.trim() ? r.expected : undefined,
			}));
			const multi = selectedModels.length > 1;
			const res = await runGatewayEvals(
				target,
				{
					agent_id: agentId,
					model,
					models: multi ? selectedModels : undefined,
					system_prompt: promptDraft,
					judge_model: judgeModel.trim() || undefined,
					dataset,
				},
				controller.signal
			);
			setResult(res);
		} catch (e) {
			if (!controller.signal.aborted) {
				setError(e instanceof Error ? e.message : String(e));
			}
		} finally {
			setRunning(false);
		}
	}, [rows, selectedModels, target, agentId, model, promptDraft, judgeModel]);

	const handleRun = useCallback(() => {
		run().catch(() => {
			// errors are surfaced via setError inside run().
		});
	}, [run]);

	return (
		<section className="flex flex-col gap-3 rounded-xl border p-4">
			<div className="flex items-center gap-2">
				<span className="font-semibold text-base">Test cases</span>
				<span className="text-muted-foreground text-xs">
					Runs the draft prompt as a system prompt against your cases
				</span>
			</div>

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

			{/* Run controls */}
			<div className="flex flex-wrap items-center gap-2">
				<Button disabled={runDisabled} onClick={handleRun} size="sm">
					{running ? (
						<Spinner />
					) : (
						<HugeiconsIcon className="size-3" icon={PlayIcon} />
					)}
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

			{/* Results matrix */}
			{result ? (
				<ResultsMatrix model={model} result={result} rows={rows} />
			) : null}
		</section>
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
				<Button onClick={onAddRow} size="sm" variant="outline">
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
			onUpdate(row.id, { vars: { ...row.vars, [name]: val } });
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
					className="h-7 max-w-48 text-xs"
					onChange={(e) => onUpdate(row.id, { name: e.target.value })}
					placeholder="Name (optional)"
					value={row.name}
				/>
				<Button
					className="ml-auto"
					onClick={() => onRemove(row.id)}
					size="icon-sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3" icon={Delete02Icon} />
				</Button>
			</div>

			<div className="flex flex-col gap-1">
				<Label className="text-xs">User message</Label>
				<Textarea
					className="min-h-16 font-mono text-xs"
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
								className="h-7 text-xs"
								onChange={(e) => handleVarChange(name, e.target.value)}
								placeholder={`Value for {{${name}}}`}
								value={row.vars[name] ?? ""}
							/>
						</div>
					))}
				</div>
			) : null}

			<div className="flex flex-col gap-1">
				<Label className="text-xs">Expected (optional substring)</Label>
				<Input
					className="h-7 text-xs"
					onChange={(e) => onUpdate(row.id, { expected: e.target.value })}
					placeholder="Substring the response should contain"
					value={row.expected}
				/>
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
	const needsText = assertion.kind !== "json_valid";
	const isJudge = assertion.kind === "llm_judge";

	const handleKindChange = useCallback(
		(kind: AssertionKind) => {
			// Preserve the existing text payload where the new kind supports one.
			const text = assertionText(assertion);
			const base = defaultAssertion(kind);
			onUpdate(withAssertionText(base, text));
		},
		[assertion, onUpdate]
	);

	const handleTextChange = useCallback(
		(text: string) => {
			onUpdate(withAssertionText(assertion, text));
		},
		[assertion, onUpdate]
	);

	let placeholder = "Value";
	if (isJudge) {
		placeholder = "Rubric: what the answer must satisfy";
	} else if (assertion.kind === "regex") {
		placeholder = "Regular expression";
	}

	return (
		<div className="flex items-center gap-2">
			<NativeSelect
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
			<Button onClick={onRemove} size="icon-sm" variant="ghost">
				<HugeiconsIcon className="size-3" icon={Cancel01Icon} />
			</Button>
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
						<Button onClick={onAddModel} size="icon-sm" variant="outline">
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
	result: EvalRunResult;
	rows: TestCaseRow[];
}

function ResultsMatrix({ result, rows, model }: ResultsMatrixProps) {
	// Back-compat read path: single-model responses have no `models` key, so
	// synthesize one entry from the top-level cases/aggregate.
	const models: ModelEvalResult[] = result.models ?? [
		{ model, cases: result.cases, aggregate: result.aggregate },
	];

	const caseCount = Math.max(rows.length, ...models.map((m) => m.cases.length));
	const caseIndices = Array.from({ length: caseCount }, (_, i) => i);

	return (
		<div className="flex flex-col gap-3">
			{/* Per-model aggregate stat cards */}
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
				{models.map((m) => (
					<ModelStatCard key={m.model} result={m} />
				))}
			</div>

			{/* Case × model matrix */}
			<div className="overflow-auto rounded-lg border">
				<table className="w-full text-left text-xs">
					<thead className="bg-muted/50 text-muted-foreground">
						<tr>
							<th className="px-2 py-1.5 font-medium">Case</th>
							{models.map((m) => (
								<th className="px-2 py-1.5 font-medium" key={m.model}>
									{m.model}
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
								{models.map((m) => (
									<td className="min-w-48 max-w-72 px-2 py-1.5" key={m.model}>
										<MatrixCell score={m.cases[idx]} />
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
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
			<span className={`font-semibold text-xs ${tone ?? ""}`}>{value}</span>
		</div>
	);
}

function MatrixCell({ score }: { score: EvalCaseScore | undefined }) {
	if (!score) {
		return <span className="text-muted-foreground">—</span>;
	}
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex flex-wrap items-center gap-1">
				<Badge
					className={`text-[10px] ${score.assertions_pass ? "" : "border-destructive text-destructive"}`}
					variant={score.assertions_pass ? "secondary" : "outline"}
				>
					{score.assertions_pass ? "pass" : "fail"}
				</Badge>
				<span className={`font-semibold ${scoreTone(score.overall)}`}>
					{pct(score.overall)}
				</span>
			</div>
			<AssertionChips assertions={score.assertions} />
			<p className="line-clamp-4 whitespace-pre-wrap break-words text-muted-foreground">
				{score.response_text}
			</p>
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

	const { messages, status, error, stop } = useChat({
		id: convId,
		initialMessages: [
			{
				id: "preview-user",
				role: "user",
				parts: [{ type: "text" as const, text: previewMessage }],
			},
		],
		transport: new DefaultChatTransport({
			api: chatStreamUrl(target),
			headers: (): Record<string, string> => chatHeaders(target),
			body: () => ({
				agent_id: agentId,
				conversation_id: convId,
				enable_long_term: false,
			}),
		}),
	});

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
