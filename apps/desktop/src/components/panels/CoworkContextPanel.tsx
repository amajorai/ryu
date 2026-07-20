// apps/desktop/src/components/panels/CoworkContextPanel.tsx
//
// The "Cowork" context rail (Codex / Claude-cowork style). A read-only summary of
// what the current run is doing and touching, surfaced beside the transcript:
//
//   • Progress  — the agent's live plan (the latest `tool-TodoWrite` snapshot in
//                 the message stream), rendered as an in-place checklist.
//   • Artifacts — files the agent created this run (worktree diff, kind="added").
//   • Context   — the selected project folder + branch (workspace + git status).
//   • Changes   — the aggregate worktree diff with Apply / Open PR (DiffReviewPane).
//   • Sources   — connectors the run actually used, derived from its tool calls
//                 (web search, GitHub, Gmail, MCP servers, local files).
//   • Side chats— persisted `/btw` asides for this conversation (see Phase 2).
//
// Everything except Artifacts/Changes is derived from the live stream, so it is
// correct while a run unfolds but resets on reload (matching Codex's "Steps will
// show as the task unfolds." empty state). Artifacts/Changes come from Core's
// per-run worktree diff and survive reload.

import {
	BrowserIcon,
	CheckmarkCircle02Icon,
	Delete01Icon,
	File01Icon,
	Flowchart01Icon,
	FolderOpenIcon,
	GitBranchIcon,
	Globe02Icon,
	Image02Icon,
	Mail01Icon,
	MessageQuestionIcon,
	PlusSignIcon,
	Robot01Icon,
	SourceCodeIcon,
	Target02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils";
import type { UIMessage } from "ai";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { DiffReviewPane } from "@/src/components/chat/DiffReviewPane.tsx";
import {
	SubagentAvatar,
	subagentName,
} from "@/src/components/panels/subagent-identity.tsx";
import {
	BouncyAccordion,
	type BouncyAccordionItem,
} from "@/src/components/ui/bouncy-accordion.tsx";
import type { BtwEntry } from "@/src/lib/api/btw.ts";
import { deleteBtw, listBtw } from "@/src/lib/api/btw.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { FileSummary } from "@/src/lib/api/git.ts";
import { fetchWorktreeDiff } from "@/src/lib/api/git.ts";
import type { Artifact, ArtifactKind } from "@/src/lib/artifacts.ts";
import { extractArtifacts } from "@/src/lib/artifacts.ts";
import { compactAge } from "@/src/lib/time.ts";

// ── Message-stream shapes (loose, mirroring the AI SDK parts we read) ──────────

interface StreamPart {
	input?: unknown;
	output?: unknown;
	/** Present on tool parts. Nested (subagent) tools carry `<parentTaskId>:<id>`. */
	state?: string;
	toolCallId?: string;
	type?: string;
}

interface StreamMessage {
	parts?: StreamPart[];
	role?: string;
}

export interface CoworkPlanTodo {
	content: string;
	status: "pending" | "in_progress" | "completed";
}

export interface CoworkContextPanelProps {
	/** Live chat status from useChat, so the in-progress step can pulse. */
	chatStatus?: string;
	/**
	 * Extra accordion items rendered above the derived sections (Progress /
	 * Artifacts / …). The pinned-summary card injects its "Environment" section
	 * (pickers + git + commit & push) here so the whole panel is one accordion.
	 */
	leadingItems?: BouncyAccordionItem[];
	/** The conversation's message stream (AI SDK UIMessages). */
	messages: StreamMessage[];
	/**
	 * Open a detected rendered/canvas artifact (html/svg/mermaid/large code block)
	 * in the right panel's ArtifactRenderer.
	 */
	onOpenArtifact?: (artifact: Artifact) => void;
	/** Reopen a persisted side chat (the host shows it in the btw overlay). */
	onOpenSideChat?: (entry: BtwEntry) => void;
	/**
	 * Open a spawned subagent's transcript in the right panel. The host reads the
	 * subagent id and re-derives the live transcript from the message stream.
	 */
	onOpenSubagent?: (subagent: SubagentSummary) => void;
	/** The active conversation id (== worktree run id). Null on a fresh chat. */
	runId: string | null;
	/** Bumped by the host after a new `/btw` so the side-chats list refetches. */
	sideChatsRefreshKey?: number;
	/** Node target for the worktree-diff / git-status fetches. */
	target: ApiTarget;
}

// ── Derivations from the message stream ────────────────────────────────────────

const PLAN_PART_TYPE = "tool-TodoWrite";

function isToolPart(part: StreamPart): boolean {
	return (
		part.type === "dynamic-tool" ||
		(typeof part.type === "string" && part.type.startsWith("tool-"))
	);
}

/** The most recent plan snapshot (Core re-sends the full list each update). */
function extractLatestTodos(messages: StreamMessage[]): CoworkPlanTodo[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const parts = messages[i]?.parts;
		if (!parts) {
			continue;
		}
		for (let j = parts.length - 1; j >= 0; j--) {
			const part = parts[j];
			if (part.type !== PLAN_PART_TYPE) {
				continue;
			}
			const input = part.input as { todos?: CoworkPlanTodo[] } | undefined;
			const todos = input?.todos;
			if (Array.isArray(todos) && todos.length > 0) {
				return todos;
			}
		}
	}
	return [];
}

interface DerivedSource {
	icon: IconSvgElement;
	id: string;
	label: string;
}

/**
 * Map a tool part type to the connector/source it represents. Returns null for
 * tool parts that aren't a recognisable external source (so a run that only
 * thinks/writes shows just "Local files", not noise).
 */
function sourceForToolType(type: string): DerivedSource | null {
	if (type === "tool-WebSearch" || type === "tool-WebFetch") {
		return { id: "web", label: "Web search", icon: Globe02Icon };
	}
	if (type === "tool-cloning") {
		return { id: "github", label: "GitHub", icon: SourceCodeIcon };
	}
	if (
		type === "tool-Read" ||
		type === "tool-Write" ||
		type === "tool-Edit" ||
		type === "tool-Grep" ||
		type === "tool-Glob" ||
		type === "tool-Bash" ||
		type === "tool-NotebookEdit"
	) {
		return { id: "local", label: "Local files", icon: FolderOpenIcon };
	}
	// MCP tools carry the server name: tool-mcp__<server>__<tool>.
	const mcpMatch = /^tool-mcp__([^_]+(?:_[^_]+)*?)__/.exec(type);
	if (mcpMatch) {
		const server = mcpMatch[1].toLowerCase();
		if (server.includes("gmail") || server.includes("mail")) {
			return { id: "gmail", label: "Gmail", icon: Mail01Icon };
		}
		if (server.includes("github") || server.includes("git")) {
			return { id: "github", label: "GitHub", icon: SourceCodeIcon };
		}
		const pretty = server.charAt(0).toUpperCase() + server.slice(1);
		return { id: `mcp-${server}`, label: pretty, icon: Globe02Icon };
	}
	return null;
}

/** Distinct sources used across the whole conversation, first-seen order. */
function extractSources(messages: StreamMessage[]): DerivedSource[] {
	const byId = new Map<string, DerivedSource>();
	for (const message of messages) {
		if (!message.parts) {
			continue;
		}
		for (const part of message.parts) {
			if (!(isToolPart(part) && typeof part.type === "string")) {
				continue;
			}
			const source = sourceForToolType(part.type);
			if (source && !byId.has(source.id)) {
				byId.set(source.id, source);
			}
		}
	}
	return [...byId.values()];
}

// ── Subagents (Task/Agent tool spawns) ─────────────────────────────────────────

// A run spawns a subagent via the `Task`/`Agent` tool (Claude Code / ACP). Each
// spawn is a tool part in the stream, and the tools the subagent itself ran are
// nested tool parts whose `toolCallId` is prefixed `<parentTaskId>:` — the same
// scheme the message list uses to fold nested rows under a subagent (see
// packages/blocks/.../message-list.tsx). We reconstruct each subagent's chat
// (prompt → its tool steps → its result) from those parts so it can be reopened
// in the right panel, with no extra endpoint.

const SUBAGENT_PART_TYPES = new Set(["tool-Task", "tool-Agent"]);
const TOOL_PREFIX_RE = /^tool-/;
const WHITESPACE_RE = /\s+/g;

export interface SubagentSummary {
	/**
	 * A live one-line description of what the subagent is doing right now (its
	 * latest tool step). Empty once done. Recomputed on every stream tick so the
	 * panel row updates live instead of only at the end.
	 */
	activity: string;
	/** The Task/Agent tool call id — stable key + the transcript's identity. */
	id: string;
	/** The subagent kind (`subagent_type`), e.g. "code-reviewer". */
	label: string;
	/** A stable, friendly English name derived from `id`, e.g. "Atlas". */
	name: string;
	status: "running" | "done";
	/** The one-line task description, if any. */
	subtitle: string;
	/** A reconstructed read-only transcript for the right panel's MessageList. */
	transcript: UIMessage[];
}

/** Best-effort text extraction from a tool part's loose input/output shapes. */
function partText(value: unknown): string {
	if (value == null) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(partText).filter(Boolean).join("\n");
	}
	if (typeof value === "object") {
		const obj = value as Record<string, unknown>;
		if (typeof obj.text === "string") {
			return obj.text;
		}
		if (obj.content !== undefined) {
			return partText(obj.content);
		}
		if (obj.output !== undefined) {
			return partText(obj.output);
		}
		if (typeof obj.result === "string") {
			return obj.result;
		}
	}
	return "";
}

/** Drop the `<parentTaskId>:` prefix so a nested tool renders as a top-level row. */
function stripParentPrefix(part: StreamPart): StreamPart {
	const id = part.toolCallId;
	if (typeof id === "string" && id.includes(":")) {
		return { ...part, toolCallId: id.slice(id.indexOf(":") + 1) };
	}
	return part;
}

interface SubagentParts {
	/** The subagent's own tool calls, prefix-stripped and stream-ordered. */
	nested: Map<string, StreamPart[]>;
	/** The subagent's final answer text, concatenated from `tool-TaskOutput`. */
	output: Map<string, string>;
}

/** Split the stream's parts into per-subagent tool steps and output text. */
function groupSubagentParts(
	allParts: StreamPart[],
	taskIds: Set<string>
): SubagentParts {
	const nested = new Map<string, StreamPart[]>();
	const output = new Map<string, string>();
	for (const part of allParts) {
		const id = part.toolCallId;
		if (typeof id !== "string" || !id.includes(":")) {
			continue;
		}
		const parent = id.slice(0, id.indexOf(":"));
		if (!taskIds.has(parent)) {
			continue;
		}
		// `tool-TaskOutput` carries the subagent's final answer, not a tool step.
		if (part.type === "tool-TaskOutput") {
			const text = partText(part.output ?? part.input);
			if (text) {
				output.set(parent, (output.get(parent) ?? "") + text);
			}
			continue;
		}
		const list = nested.get(parent);
		if (list) {
			list.push(part);
		} else {
			nested.set(parent, [part]);
		}
	}
	return { nested, output };
}

/** Shorten a detail string for a single compact activity line. */
function shortenDetail(value: string): string {
	const trimmed = value.replace(WHITESPACE_RE, " ").trim();
	return trimmed.length > 40 ? `${trimmed.slice(0, 39)}…` : trimmed;
}

/** A live one-line label for the subagent's most recent tool step. */
function latestActivity(nested: StreamPart[]): string {
	if (nested.length === 0) {
		return "Starting…";
	}
	const last = nested.at(-1);
	if (!last) {
		return "Working…";
	}
	const name =
		typeof last.type === "string"
			? last.type.replace(TOOL_PREFIX_RE, "")
			: "tool";
	const input = last.input as Record<string, unknown> | undefined;
	const detail =
		input?.file_path ??
		input?.command ??
		input?.pattern ??
		input?.query ??
		input?.path ??
		input?.description;
	const detailStr =
		typeof detail === "string" && detail ? ` ${shortenDetail(detail)}` : "";
	return `${name}${detailStr}`;
}

/** Reconstruct one subagent's summary + read-only transcript from its parts. */
function toSubagentSummary(
	task: StreamPart,
	grouped: SubagentParts
): SubagentSummary {
	const id = task.toolCallId as string;
	const input = task.input as
		| { description?: string; prompt?: string; subagent_type?: string }
		| undefined;
	const subtitle = input?.description || "";
	const status: SubagentSummary["status"] =
		task.state === "output-available" || task.state === "output-error"
			? "done"
			: "running";
	const prompt = input?.prompt || subtitle || "Subagent task";
	const nested = (grouped.nested.get(id) ?? []).map(stripParentPrefix);
	const activity = status === "running" ? latestActivity(nested) : "";
	const outputText = grouped.output.get(id) || partText(task.output);

	const assistantParts: unknown[] = [...nested];
	if (outputText) {
		assistantParts.push({ type: "text", text: outputText });
	}
	const transcript = [
		{
			id: `${id}:prompt`,
			role: "user",
			parts: [{ type: "text", text: prompt }],
		},
		{ id: `${id}:result`, role: "assistant", parts: assistantParts },
	] as unknown as UIMessage[];

	return {
		id,
		name: subagentName(id),
		label: input?.subagent_type || "Agent",
		subtitle,
		status,
		activity,
		transcript,
	};
}

/** Subagents spawned by the run, newest-relevant order preserved (stream order). */
export function extractSubagents(messages: StreamMessage[]): SubagentSummary[] {
	const allParts: StreamPart[] = [];
	for (const message of messages) {
		for (const part of message.parts ?? []) {
			allParts.push(part);
		}
	}

	const tasks = allParts.filter(
		(p) =>
			typeof p.type === "string" &&
			SUBAGENT_PART_TYPES.has(p.type) &&
			typeof p.toolCallId === "string"
	);
	if (tasks.length === 0) {
		return [];
	}

	const taskIds = new Set(tasks.map((t) => t.toolCallId as string));
	const grouped = groupSubagentParts(allParts, taskIds);
	return tasks.map((task) => toSubagentSummary(task, grouped));
}

function SubagentsList({
	subagents,
	onOpen,
}: {
	onOpen?: (subagent: SubagentSummary) => void;
	subagents: SubagentSummary[];
}) {
	return (
		<ul className="flex flex-col gap-0.5">
			{subagents.map((sub) => {
				// While running, the second line shows the live current tool step
				// (recomputed each stream tick); once done it falls back to the task
				// description so the row stays informative.
				const secondary =
					sub.status === "running" ? sub.activity : sub.subtitle;
				return (
					<li key={sub.id}>
						<button
							className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/50"
							onClick={() => onOpen?.(sub)}
							type="button"
						>
							<SubagentAvatar className="size-6" seed={sub.id} />
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="flex min-w-0 items-center gap-1.5">
									<span className="truncate text-foreground text-sm">
										{sub.name}
									</span>
									<span className="shrink-0 truncate text-muted-foreground/70 text-xs">
										{sub.label}
									</span>
								</span>
								{secondary && (
									<span className="truncate text-muted-foreground text-xs">
										{secondary}
									</span>
								)}
							</span>
							{sub.status === "running" && (
								<span
									className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
									title="Running"
								/>
							)}
						</button>
					</li>
				);
			})}
		</ul>
	);
}

// ── Rendered / canvas artifacts (html · svg · mermaid · code) ─────────────────

// DISTINCT from the worktree "Artifacts" section above (files created on disk):
// these are renderable payloads found in the assistant's own message text
// (extractArtifacts), opened in a sandboxed ArtifactRenderer in the right panel.

const ARTIFACT_KIND_ICON: Record<ArtifactKind, IconSvgElement> = {
	html: BrowserIcon,
	svg: Image02Icon,
	mermaid: Flowchart01Icon,
	code: SourceCodeIcon,
};

const ARTIFACT_KIND_LABEL: Record<ArtifactKind, string> = {
	html: "HTML",
	svg: "SVG",
	mermaid: "Diagram",
	code: "Code",
};

function RenderedArtifactsList({
	artifacts,
	onOpen,
}: {
	artifacts: Artifact[];
	onOpen?: (artifact: Artifact) => void;
}) {
	return (
		<ul className="flex flex-col gap-0.5">
			{artifacts.map((artifact) => (
				<li key={artifact.id}>
					<button
						className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/50"
						onClick={() => onOpen?.(artifact)}
						type="button"
					>
						<HugeiconsIcon
							aria-hidden
							className="size-3.5 shrink-0 text-muted-foreground"
							icon={ARTIFACT_KIND_ICON[artifact.kind]}
						/>
						<span className="min-w-0 flex-1 truncate text-foreground text-sm">
							{artifact.title}
						</span>
						<span className="shrink-0 text-[10px] text-muted-foreground/70 uppercase tracking-wide">
							{ARTIFACT_KIND_LABEL[artifact.kind]}
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}

// ── Accordion section helpers (same gooey BouncyAccordion as Getting started) ──

function SectionIcon({ icon }: { icon: IconSvgElement }) {
	return <HugeiconsIcon aria-hidden className="size-4" icon={icon} />;
}

function SectionTitle({ title, count }: { count?: number; title: string }) {
	return (
		<span className="flex items-center gap-2">
			<span className="font-medium text-foreground text-xs">{title}</span>
			{count !== undefined && count > 0 && (
				<span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground tabular-nums">
					{count}
				</span>
			)}
		</span>
	);
}

function EmptyHint({ children }: { children: ReactNode }) {
	return <p className="py-1 text-muted-foreground text-xs">{children}</p>;
}

// ── Progress checklist ─────────────────────────────────────────────────────────

function TodoStatusDot({
	status,
	pulse,
}: {
	pulse: boolean;
	status: CoworkPlanTodo["status"];
}) {
	if (status === "completed") {
		return (
			<HugeiconsIcon
				aria-hidden
				className="size-4 shrink-0 text-primary"
				icon={CheckmarkCircle02Icon}
			/>
		);
	}
	if (status === "in_progress") {
		return (
			<span
				className={cn(
					"mt-px flex size-3.5 shrink-0 items-center justify-center rounded-full border-2 border-primary",
					pulse && "animate-pulse"
				)}
			/>
		);
	}
	return (
		<span className="mt-px size-3.5 shrink-0 rounded-full border border-muted-foreground/40" />
	);
}

function ProgressSection({
	todos,
	chatStatus,
}: {
	chatStatus?: string;
	todos: CoworkPlanTodo[];
}) {
	const isStreaming = chatStatus === "streaming" || chatStatus === "submitted";
	if (todos.length === 0) {
		return <EmptyHint>Steps will show as the task unfolds.</EmptyHint>;
	}
	return (
		<ul className="flex flex-col gap-2">
			{todos.map((todo, idx) => (
				<li
					className="flex items-start gap-2"
					key={`${idx}-${todo.content.slice(0, 24)}`}
				>
					<TodoStatusDot
						pulse={isStreaming && todo.status === "in_progress"}
						status={todo.status}
					/>
					<span
						className={cn(
							"text-sm leading-snug",
							todo.status === "completed"
								? "text-muted-foreground line-through"
								: todo.status === "in_progress"
									? "text-foreground"
									: "text-muted-foreground"
						)}
					>
						{todo.content}
					</span>
				</li>
			))}
		</ul>
	);
}

// ── File row (artifacts) ───────────────────────────────────────────────────────

function FileRow({ file }: { file: FileSummary }) {
	const filename = file.path.split(/[\\/]/).at(-1) ?? file.path;
	return (
		<div className="flex items-center gap-2 py-1 text-sm" title={file.path}>
			<HugeiconsIcon
				aria-hidden
				className="size-3.5 shrink-0 text-muted-foreground"
				icon={File01Icon}
			/>
			<span className="min-w-0 flex-1 truncate text-foreground">
				{filename}
			</span>
		</div>
	);
}

// ── Side chats (persisted /btw asides) ─────────────────────────────────────────

function SideChatsList({
	entries,
	onOpen,
	onDelete,
}: {
	entries: BtwEntry[];
	onDelete: (id: string) => void;
	onOpen?: (entry: BtwEntry) => void;
}) {
	return (
		<ul className="flex flex-col gap-0.5">
			{entries.map((entry) => (
				<li className="group/side flex items-center gap-1" key={entry.id}>
					<button
						className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/50"
						onClick={() => onOpen?.(entry)}
						type="button"
					>
						<HugeiconsIcon
							aria-hidden
							className="size-3.5 shrink-0 text-muted-foreground"
							icon={MessageQuestionIcon}
						/>
						<span className="min-w-0 flex-1 truncate text-foreground text-sm">
							{entry.question}
						</span>
						<span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
							{compactAge(entry.created_at)}
						</span>
					</button>
					<button
						aria-label="Delete side chat"
						className="flex size-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-accent group-hover/side:opacity-100"
						onClick={() => onDelete(entry.id)}
						type="button"
					>
						<HugeiconsIcon
							className="size-3 text-muted-foreground"
							icon={Delete01Icon}
						/>
					</button>
				</li>
			))}
		</ul>
	);
}

// ── Main panel ──────────────────────────────────────────────────────────────────

export function CoworkContextPanel({
	messages,
	runId,
	target,
	chatStatus,
	onOpenArtifact,
	onOpenSideChat,
	onOpenSubagent,
	sideChatsRefreshKey,
	leadingItems,
}: CoworkContextPanelProps) {
	const todos = useMemo(() => extractLatestTodos(messages), [messages]);
	const sources = useMemo(() => extractSources(messages), [messages]);
	const subagents = useMemo(() => extractSubagents(messages), [messages]);
	const artifacts = useMemo(() => extractArtifacts(messages), [messages]);

	// Created files come from the run's worktree diff (server-persisted), so they
	// survive reload. Refetched when the run changes or a stream completes.
	const [createdFiles, setCreatedFiles] = useState<FileSummary[]>([]);
	const [diffHasChanges, setDiffHasChanges] = useState(false);
	// Side chats (persisted /btw asides) — lifted here so the section can hide
	// itself entirely when there are none.
	const [sideChats, setSideChats] = useState<BtwEntry[]>([]);

	const targetUrlRef = useRef(target);
	targetUrlRef.current = target;

	useEffect(() => {
		if (!runId) {
			setCreatedFiles([]);
			setDiffHasChanges(false);
			return;
		}
		const controller = new AbortController();
		fetchWorktreeDiff(targetUrlRef.current, runId, controller.signal)
			.then((diff) => {
				if (!controller.signal.aborted) {
					setCreatedFiles(diff.files.filter((f) => f.kind === "added"));
					setDiffHasChanges(diff.has_changes);
				}
			})
			.catch(() => {
				/* treated as "no artifacts" */
			});
		return () => controller.abort();
		// Re-run when the chat goes idle so a just-finished run's files appear.
	}, [runId]);

	useEffect(() => {
		if (!runId) {
			setSideChats([]);
			return;
		}
		const controller = new AbortController();
		listBtw(targetUrlRef.current, runId, controller.signal)
			.then((list) => {
				if (!controller.signal.aborted) {
					setSideChats(list);
				}
			})
			.catch(() => {
				/* treated as "no side chats" */
			});
		return () => controller.abort();
	}, [runId]);

	const handleDeleteSideChat = useCallback((id: string) => {
		setSideChats((prev) => prev.filter((e) => e.id !== id));
		deleteBtw(targetUrlRef.current, id).catch(() => {
			/* leave the optimistic removal; a refetch restores it if needed */
		});
	}, []);

	// One accordion for the whole panel. `leadingItems` (the pinned card's
	// Environment section) go first; each derived section is only added when it
	// has something to show, so empty sections disappear rather than showing a
	// hint. The project/branch/commit summary lives in leadingItems now, not
	// here (see PinnedSummaryPanel).
	const items: BouncyAccordionItem[] = [...(leadingItems ?? [])];

	if (todos.length > 0) {
		items.push({
			id: "progress",
			icon: <SectionIcon icon={Target02Icon} />,
			title: <SectionTitle count={todos.length} title="Progress" />,
			description: <ProgressSection chatStatus={chatStatus} todos={todos} />,
		});
	}

	if (createdFiles.length > 0) {
		items.push({
			id: "artifacts",
			icon: <SectionIcon icon={PlusSignIcon} />,
			title: <SectionTitle count={createdFiles.length} title="Artifacts" />,
			description: (
				<div className="flex flex-col">
					{createdFiles.map((file) => (
						<FileRow file={file} key={file.path} />
					))}
				</div>
			),
		});
	}

	if (runId && diffHasChanges) {
		items.push({
			id: "changes",
			icon: <SectionIcon icon={GitBranchIcon} />,
			title: <SectionTitle title="Changes" />,
			description: <DiffReviewPane runId={runId} target={target} />,
		});
	}

	if (artifacts.length > 0) {
		items.push({
			id: "rendered-artifacts",
			icon: <SectionIcon icon={BrowserIcon} />,
			title: (
				<SectionTitle count={artifacts.length} title="Rendered artifacts" />
			),
			description: (
				<RenderedArtifactsList artifacts={artifacts} onOpen={onOpenArtifact} />
			),
		});
	}

	if (sources.length > 0) {
		items.push({
			id: "sources",
			icon: <SectionIcon icon={Globe02Icon} />,
			title: <SectionTitle count={sources.length} title="Sources" />,
			description: (
				<div className="flex flex-col">
					{sources.map((source) => (
						<div
							className="flex items-center gap-2 py-1 text-sm"
							key={source.id}
						>
							<HugeiconsIcon
								aria-hidden
								className="size-3.5 shrink-0 text-muted-foreground"
								icon={source.icon}
							/>
							<span className="text-foreground">{source.label}</span>
						</div>
					))}
				</div>
			),
		});
	}

	if (subagents.length > 0) {
		items.push({
			id: "subagents",
			icon: <SectionIcon icon={Robot01Icon} />,
			title: <SectionTitle count={subagents.length} title="Subagents" />,
			description: (
				<SubagentsList onOpen={onOpenSubagent} subagents={subagents} />
			),
		});
	}

	if (runId && sideChats.length > 0) {
		items.push({
			id: "side-chats",
			icon: <SectionIcon icon={MessageQuestionIcon} />,
			title: <SectionTitle count={sideChats.length} title="Side chats" />,
			description: (
				<SideChatsList
					entries={sideChats}
					onDelete={handleDeleteSideChat}
					onOpen={onOpenSideChat}
				/>
			),
		});
	}

	if (items.length === 0) {
		return null;
	}

	return (
		<div className="h-full overflow-y-auto p-2">
			<BouncyAccordion
				classNames={{
					item: "border border-border/60",
					description: "text-sm",
				}}
				defaultValue={items[0]?.id ?? null}
				items={items}
			/>
		</div>
	);
}
