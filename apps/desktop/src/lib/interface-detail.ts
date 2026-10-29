// What a thread's saved message parts say about it, for the interface
// snapshot (spec docs/interfaces-useful-state.md §3.2, phase 1b): the current
// step, plan or workflow progress, why it stopped, what the last finished turn
// produced, and the Question cards still open. Pure: the hydration loop feeds
// it the newest message page of a thread.

import {
	answeredQuestionIds,
	isAsyncQuestionPart,
	isQuestionPartOpen,
} from "@ryu/blocks/desktop/agent-elements/question/async-question.ts";
import {
	formatToolDisplayName,
	toolRegistry,
} from "@ryu/blocks/desktop/agent-elements/tools/tool-registry.ts";
import { readToolTiming } from "@ryu/blocks/desktop/agent-elements/tools/tool-timing.tsx";
import { deriveEditedFiles } from "@ryu/blocks/desktop/agent-elements/turn-end-cards.ts";
import { extractWorkflowRun } from "@ryu/blocks/desktop/agent-elements/workflow-run-data.ts";
import {
	type InterfaceActivity,
	type InterfaceActivityKind,
	type InterfaceAsk,
	type InterfaceAskChoice,
	type InterfaceBlocker,
	type InterfaceBlockerKind,
	type InterfaceOutcome,
	type InterfaceProgress,
	stepKindForTool,
} from "@ryuhq/protocol/interfaces";
import { extractArtifacts } from "@/src/lib/artifacts.ts";
import {
	buildMissionDigest,
	type MissionStreamMessage,
	type MissionStreamPart,
	toolNameOf,
} from "@/src/lib/mission-control/turn-groups.ts";
import { deriveTodoProgress } from "@/src/lib/todo-progress.ts";

/** Core's question and permission waiters give up after 600 s. */
export const QUESTION_WAIT_MS = 600_000;
const LABEL_MAX = 40;
const TITLE_MAX = 40;
const DETAIL_MAX = 160;
const TEXT_MAX = 80;
const RECENT_STEPS = 5;
const MAX_CHOICES = 4;

/** The message fields the deriver reads (persisted `Message` satisfies it). */
export interface DetailMessage {
	content?: string;
	id: string;
	interrupted?: boolean;
	parts?: readonly unknown[];
	role: "assistant" | "user";
	timestamp: number;
}

export interface DeriveDetailExtras {
	/** Agent of the conversation that holds the parts. */
	agentId: string | null;
	/** Older messages exist before this page (counts at the boundary are absent). */
	hasOlder: boolean;
	/** Where this conversation's asks surface: a helper session lifts them to
	 *  its parent main thread. Defaults to the conversation itself. */
	liftTo?: { agentId: string | null; threadId: string };
	nowMs: number;
	/** The conversation itself is running (questions block only then). */
	running: boolean;
	/** Conversation id that holds the parts. */
	threadId: string;
}

/** Newest step and message times (ms): over the whole page, and over the
 *  current turn only (after the newest user message), for when the host
 *  knows no run start to floor them by. */
export interface ProgressMarks {
	messageAt: number | null;
	partAt: number | null;
	turnMessageAt: number | null;
	turnPartAt: number | null;
}

export interface ThreadDetail {
	activity: InterfaceActivity | null;
	blocker: InterfaceBlocker | null;
	/** An assistant message exists after the last user message. */
	hasLaterAssistant: boolean;
	outcome: InterfaceOutcome | null;
	progress: InterfaceProgress | null;
	/** Newest tool timing and newest assistant message time on the page (ms),
	 *  so the host can floor them by the run start it resolves (spec order:
	 *  a part timing at or after the start, else a message, else the start). */
	progressMarks: ProgressMarks;
	/** Open Question cards, with the conversation each answer posts to. */
	questionAsks: Array<{
		ask: InterfaceAsk;
		holderId: string;
		toolCallId: string;
	}>;
	/** When the last user message was sent (ms), or the earliest tool start
	 *  after it when the message has no time. Null without a user message. */
	userStart: number | null;
}

/** Revision of a conversation as the detail store sees it. */
export function interfaceDetailRevision(input: {
	messageCount: number;
	runStatus: string | undefined;
	updatedAt: number;
}): string {
	return `${input.updatedAt}:${input.messageCount}:${input.runStatus ?? ""}`;
}

type LoosePart = MissionStreamPart & {
	data?: unknown;
	errorText?: unknown;
	id?: string;
	code?: unknown;
	message?: unknown;
	title?: unknown;
};

function partsOf(message: DetailMessage | undefined): LoosePart[] {
	return (message?.parts ?? []).filter(
		(part): part is LoosePart => typeof part === "object" && part !== null
	);
}

function lastWhere<T>(
	list: readonly T[],
	test: (item: T) => boolean
): T | undefined {
	for (let i = list.length - 1; i >= 0; i -= 1) {
		const item = list[i];
		if (item !== undefined && test(item)) {
			return item;
		}
	}
	return undefined;
}

type QuestionPart = Parameters<typeof isQuestionPartOpen>[0];

function isTool(part: LoosePart): boolean {
	return (
		typeof part.type === "string" &&
		(part.type.startsWith("tool-") || part.type === "dynamic-tool")
	);
}

function clamp(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

const iso = (ms: number) => new Date(ms).toISOString();

function basename(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function stringIn(source: unknown, key: string): string | null {
	if (!source || typeof source !== "object") {
		return null;
	}
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A short target from a tool's input: file basename, command head, pattern,
 *  query, path or URL host (the `latestActivity` field order). */
export function toolTarget(input: unknown): string | null {
	const file = stringIn(input, "file_path") ?? stringIn(input, "notebook_path");
	if (file) {
		return clamp(basename(file), LABEL_MAX);
	}
	const command = stringIn(input, "command");
	if (command) {
		return clamp(command.split(/\s+/).slice(0, 2).join(" "), LABEL_MAX);
	}
	const text =
		stringIn(input, "pattern") ??
		stringIn(input, "query") ??
		stringIn(input, "path");
	if (text) {
		return clamp(text, LABEL_MAX);
	}
	const url = stringIn(input, "url");
	if (url) {
		try {
			return new URL(url).host || null;
		} catch {
			return null;
		}
	}
	return null;
}

const KIND_VERBS: Record<InterfaceActivityKind, string> = {
	answer: "Writing",
	ask: "Asking",
	delegate: "Delegating",
	edit: "Editing",
	plan: "Planning",
	read: "Reading",
	run: "Running",
	search: "Searching",
	think: "Thinking",
	tool: "Using",
	web: "Fetching",
	write: "Writing",
};

function toolDisplayName(tool: string): string {
	const tail = tool.split(/__|\./).filter(Boolean).at(-1) ?? tool;
	return tail.replace(/_/g, " ");
}

/** "Editing snapshot.ts", "Running bun test", "Using create pull request". */
export function activityLabel(
	kind: InterfaceActivityKind,
	tool: string | null,
	target: string | null
): string {
	const verb = KIND_VERBS[kind];
	if (target) {
		return clamp(`${verb} ${target}`, LABEL_MAX);
	}
	if (kind === "answer") {
		return "Writing the answer";
	}
	if (kind === "tool" && tool) {
		return clamp(`${verb} ${toolDisplayName(tool)}`, LABEL_MAX);
	}
	return verb;
}

const LEADING_VERB = /^[A-Z][a-z]+ing\b/;

function registryTitle(part: { type?: unknown }): string | null {
	const meta =
		typeof part.type === "string" ? toolRegistry[part.type] : undefined;
	if (!meta) {
		return null;
	}
	try {
		const title = meta.title(part).trim();
		return title || null;
	} catch {
		return null;
	}
}

/**
 * A tool part's live label: the step's verb and its target when the input
 * names one ("Editing snapshot.ts"); otherwise the transcript registry's
 * title, kept when it leads with a verb ("Running Explore") or given the
 * step's verb; otherwise the tool's display name ("Using Create Pull
 * Request").
 */
export function toolActivityLabel(
	part: { input?: unknown; type?: unknown },
	kind: InterfaceActivityKind,
	tool: string | null
): string {
	// A known target is the most useful word: "Running bun test".
	const target = toolTarget(part.input);
	if (target) {
		return clamp(`${KIND_VERBS[kind]} ${target}`, LABEL_MAX);
	}
	const title = registryTitle(part);
	if (title && LEADING_VERB.test(title)) {
		return clamp(title, LABEL_MAX);
	}
	const toolName = tool ? toolDisplayName(tool) : "";
	if (title && title.toLowerCase() !== toolName.toLowerCase()) {
		return clamp(`${KIND_VERBS[kind]} ${title}`, LABEL_MAX);
	}
	if (!tool) {
		return activityLabel(kind, null, null);
	}
	const verb = KIND_VERBS[kind];
	const display = formatToolDisplayName(tool);
	// "Edit" while its input streams reads "Editing", not "Editing Edit".
	const stem = display.toLowerCase().replace(/e$/, "");
	return stem && verb.toLowerCase().startsWith(stem)
		? verb
		: clamp(`${verb} ${display}`, LABEL_MAX);
}

function lastUserIndex(messages: readonly DetailMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i]?.role === "user") {
			return i;
		}
	}
	return -1;
}

function deriveActivity(
	turn: readonly DetailMessage[],
	nowMs: number
): InterfaceActivity | null {
	const parts = turn.filter((m) => m.role === "assistant").flatMap(partsOf);
	const recent: InterfaceActivityKind[] = [];
	for (const part of parts) {
		if (isTool(part) && part.state?.startsWith("output")) {
			recent.push(stepKindForTool(toolNameOf(part)));
		}
	}
	// The newest step: skip markers such as step-start or data-ryu-* parts.
	const last = lastWhere(
		parts,
		(part) => isTool(part) || part.type === "reasoning" || part.type === "text"
	);
	if (!last) {
		return null;
	}
	let kind: InterfaceActivityKind;
	let tool: string | null = null;
	let target: string | null = null;
	let since: string | null = null;
	if (isTool(last) && last.state?.startsWith("input")) {
		tool = toolNameOf(last);
		kind = last.id === "acp-plan" ? "plan" : stepKindForTool(tool);
		target = toolTarget(last.input);
		const timing = readToolTiming(last);
		since = timing ? iso(timing.startedAt) : null;
	} else if (last.type === "reasoning") {
		kind = "think";
	} else if (last.type === "text") {
		kind = "answer";
	} else {
		return null;
	}
	return {
		kind,
		label: tool
			? toolActivityLabel(last, kind, tool)
			: activityLabel(kind, tool, target),
		observedAt: iso(nowMs),
		recent: recent.slice(-RECENT_STEPS),
		since,
		source: "messages",
		target,
		tool,
	};
}

function deriveProgress(
	messages: readonly DetailMessage[]
): InterfaceProgress | null {
	const todo = deriveTodoProgress(messages);
	if (todo && todo.total > 0) {
		return {
			current:
				todo.items.find((item) => item.status === "in_progress")?.label ?? null,
			done: todo.completed,
			kind: "plan",
			next: todo.items.find((item) => item.status === "pending")?.label ?? null,
			source: "messages",
			total: todo.total,
		};
	}
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role !== "assistant") {
			continue;
		}
		const run = extractWorkflowRun({
			parts: partsOf(message) as Parameters<
				typeof extractWorkflowRun
			>[0]["parts"],
		});
		if (run && run.nodes.length > 0) {
			return {
				current:
					run.nodes.find((node) => node.status === "running")?.id ?? null,
				done: run.nodes.filter((node) => node.status === "completed").length,
				kind: "workflow",
				next: null,
				source: "messages",
				total: run.nodes.length,
			};
		}
	}
	return null;
}

const AUTH_CODES = new Set([
	"auth_required",
	"native_account_required",
	"pi_account_required",
]);
const BILLING_CODES = new Set([
	"insufficient_credits",
	"provider_payment_required",
	"provider_usage_unavailable",
]);

/** Saved error code → blocker kind (spec §3.2). No code maps to rate-limited. */
export function errorCodeKind(code: string | null): InterfaceBlockerKind {
	if (code && AUTH_CODES.has(code)) {
		return "auth";
	}
	if (code && BILLING_CODES.has(code)) {
		return "billing";
	}
	return code === "execution_paused" ? "interrupted" : "error";
}

const SHELL_TOOLS = new Set(["bash", "bashoutput", "execute", "shell.run"]);

function deriveBlocker(
	turn: readonly DetailMessage[]
): InterfaceBlocker | null {
	const assistant = turn.filter((m) => m.role === "assistant");
	// 1. A saved error card.
	for (let i = assistant.length - 1; i >= 0; i -= 1) {
		const message = assistant[i];
		const error = lastWhere(partsOf(message), (part) => part.type === "error");
		if (message && error) {
			const code = typeof error.code === "string" ? error.code : null;
			const kind = errorCodeKind(code);
			const message_ = typeof error.message === "string" ? error.message : null;
			const title =
				typeof error.title === "string" && error.title.trim()
					? error.title
					: (message_ ?? "Run failed");
			return {
				at: iso(message.timestamp),
				atApprox: true,
				detail: message_ ? clamp(message_, DETAIL_MAX) : null,
				kind,
				source: "messages",
				title: clamp(title, TITLE_MAX),
			};
		}
	}
	// 2 / 3. The last failed tool; a failed shell command names its command.
	for (let i = assistant.length - 1; i >= 0; i -= 1) {
		const message = assistant[i];
		const failed = lastWhere(
			partsOf(message),
			(part) => isTool(part) && part.state === "output-error"
		);
		if (message && failed) {
			const tool = toolNameOf(failed);
			const timing = readToolTiming(failed);
			const at = timing?.completedAt;
			const errorText =
				typeof failed.errorText === "string" ? failed.errorText : null;
			const command = stringIn(failed.input, "command");
			const shell = SHELL_TOOLS.has(tool.toLowerCase()) && command;
			return {
				at: iso(at ?? message.timestamp),
				atApprox: at === undefined,
				detail: errorText ? clamp(errorText, DETAIL_MAX) : null,
				kind: shell ? "command-failed" : "tool-failed",
				source: "messages",
				title: clamp(
					shell
						? `${command.split(/\s+/).slice(0, 2).join(" ")} failed`
						: `${toolDisplayName(tool)} failed`,
					TITLE_MAX
				),
			};
		}
	}
	// 4. A turn the node died in the middle of.
	const cut = lastWhere(assistant, (message) => message.interrupted === true);
	if (cut) {
		return {
			at: iso(cut.timestamp),
			atApprox: true,
			kind: "interrupted",
			source: "messages",
			title: "Interrupted",
		};
	}
	return null;
}

function firstSentence(text: string): string | null {
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) {
		return null;
	}
	const match = /^(.+?[.!?])(\s|$)/.exec(flat);
	return clamp(match?.[1] ?? flat, DETAIL_MAX);
}

function deriveOutcome(
	messages: readonly DetailMessage[],
	hasOlder: boolean
): InterfaceOutcome | null {
	const digest = buildMissionDigest(
		messages as unknown as MissionStreamMessage[]
	);
	const turn = digest.turns.at(-1);
	// Only the newest turn, and only once it finished; a dangling tool part
	// (interrupted, an output-less question) gives no outcome.
	if (!turn || turn.status === "running") {
		return null;
	}
	const outcome: InterfaceOutcome = {
		headline: turn.headline || "Answered",
		source: "messages",
		summary: firstSentence(turn.outcome),
	};
	const cutOff = hasOlder && turn.messageIds[0] === messages[0]?.id;
	if (cutOff) {
		return outcome;
	}
	const ids = new Set(turn.messageIds);
	const turnMessages = messages.filter(
		(message) => ids.has(message.id) && message.role === "assistant"
	);
	let insertions = 0;
	let deletions = 0;
	for (const message of turnMessages) {
		for (const file of deriveEditedFiles(
			(message.parts ?? []) as Parameters<typeof deriveEditedFiles>[0]
		)) {
			insertions += file.insertions;
			deletions += file.deletions;
		}
	}
	outcome.filesChanged = turn.files.filter(
		(file) => file.kind !== "read"
	).length;
	// Every failed part once: a failed shell command is already a tool failure.
	outcome.failures = turn.tools.reduce((sum, tool) => sum + tool.failures, 0);
	outcome.insertions = insertions;
	outcome.deletions = deletions;
	outcome.artifacts = extractArtifacts(
		turnMessages as Parameters<typeof extractArtifacts>[0]
	).length;
	return outcome;
}

interface QuestionInput {
	allowCustom?: boolean;
	description?: string;
	kind?: string;
	options?: Array<{ id?: unknown; label?: unknown }>;
	title?: string;
}

function questionsOf(input: unknown): QuestionInput[] {
	if (!input || typeof input !== "object") {
		return [];
	}
	const record = input as {
		question?: QuestionInput;
		questions?: QuestionInput[];
	};
	if (Array.isArray(record.questions)) {
		return record.questions;
	}
	return record.question ? [record.question] : [];
}

function choiceLabel(label: string): string {
	const words = label.trim().split(/\s+/);
	return words.length <= 2 ? label.trim() : `${words.slice(0, 2).join(" ")}…`;
}

function singleChoices(
	questions: QuestionInput[]
): InterfaceAskChoice[] | null {
	const [only] = questions;
	const options = only?.options ?? [];
	if (
		questions.length !== 1 ||
		only?.kind !== "single" ||
		only.allowCustom ||
		options.length < 1 ||
		options.length > MAX_CHOICES
	) {
		return null;
	}
	const choices: InterfaceAskChoice[] = [];
	for (const option of options) {
		if (typeof option.id !== "string" || typeof option.label !== "string") {
			return null;
		}
		choices.push({
			id: option.id,
			label: choiceLabel(option.label),
			tone: "neutral",
		});
	}
	// Cut labels that collide would give two buttons one name: Open only.
	// Compared without case or the cut mark: "Use the" and "Use the…" collide.
	const labels = new Set(
		choices.map((choice) => choice.label.replace(/…$/, "").toLowerCase())
	);
	return labels.size === choices.length ? choices : null;
}

function deriveQuestions(
	messages: readonly DetailMessage[],
	extras: DeriveDetailExtras
): ThreadDetail["questionAsks"] {
	const asks: ThreadDetail["questionAsks"] = [];
	const owner = extras.liftTo ?? {
		agentId: extras.agentId,
		threadId: extras.threadId,
	};
	// Async cards stay open until an answer message for them appears.
	const answered = answeredQuestionIds(
		messages as Parameters<typeof answeredQuestionIds>[0]
	);
	for (const message of messages) {
		for (const part of partsOf(message)) {
			if (part.type !== "tool-Question" || !part.toolCallId) {
				continue;
			}
			if (!isQuestionPartOpen(part as unknown as QuestionPart, answered)) {
				continue;
			}
			const questions = questionsOf(part.input);
			const first = questions[0];
			if (!first?.title) {
				continue;
			}
			const asyncPart = isAsyncQuestionPart(part as unknown as QuestionPart);
			const timing = readToolTiming(part);
			const since = timing ? timing.startedAt : null;
			const ask: InterfaceAsk = {
				agentId: owner.agentId,
				blocking: !asyncPart,
				holdsRun: !asyncPart,
				id: `question:${part.toolCallId}`,
				kind: "question",
				reason: first.description ? clamp(first.description, DETAIL_MAX) : null,
				since: since === null ? null : iso(since),
				source: "messages",
				subject: null,
				target: null,
				text: clamp(first.title, TEXT_MAX),
				threadId: owner.threadId,
			};
			if (!asyncPart) {
				// Blocking only while its thread runs and before Core's waiter ends.
				if (!extras.running) {
					continue;
				}
				const startedMs = since ?? message.timestamp;
				const expires = startedMs + QUESTION_WAIT_MS;
				if (extras.nowMs > expires) {
					continue;
				}
				ask.since ??= iso(message.timestamp);
				ask.sinceApprox = since === null;
				ask.expiresAt = iso(expires);
				ask.expiresApprox = true;
				const choices = singleChoices(questions);
				if (choices) {
					ask.choices = choices;
				}
			}
			asks.push({
				ask,
				holderId: extras.threadId,
				toolCallId: part.toolCallId,
			});
		}
	}
	return asks;
}

function newestTimes(messages: readonly DetailMessage[]): {
	messageAt: number | null;
	partAt: number | null;
} {
	let partAt: number | null = null;
	let messageAt: number | null = null;
	for (const message of messages) {
		// A missing or broken timestamp must not poison the newest time.
		if (message.role === "assistant" && Number.isFinite(message.timestamp)) {
			messageAt = Math.max(messageAt ?? message.timestamp, message.timestamp);
		}
		for (const part of partsOf(message)) {
			const timing = isTool(part) ? readToolTiming(part) : null;
			const at = timing?.completedAt ?? timing?.startedAt;
			if (at !== undefined && Number.isFinite(at)) {
				partAt = Math.max(partAt ?? at, at);
			}
		}
	}
	return { messageAt, partAt };
}

function progressMarksOf(
	messages: readonly DetailMessage[],
	turn: readonly DetailMessage[]
): ProgressMarks {
	const page = newestTimes(messages);
	const current = newestTimes(turn);
	return {
		messageAt: page.messageAt,
		partAt: page.partAt,
		turnMessageAt: current.messageAt,
		turnPartAt: current.partAt,
	};
}

/** When a running thread last moved, never before its run started: the
 *  newest part timing at or after the start, else the newest message at or
 *  after it, else the start itself. With no start, only the current turn. */
export function resolveLastProgress(
	marks: ProgressMarks,
	runStartedAtMs: number | null | undefined
): number | null {
	if (runStartedAtMs === null || runStartedAtMs === undefined) {
		return marks.turnPartAt ?? marks.turnMessageAt;
	}
	if (marks.partAt !== null && marks.partAt >= runStartedAtMs) {
		return marks.partAt;
	}
	if (marks.messageAt !== null && marks.messageAt >= runStartedAtMs) {
		return marks.messageAt;
	}
	return runStartedAtMs;
}

/** Everything the newest message page says about one conversation. */
export function deriveThreadDetail(
	messages: readonly DetailMessage[],
	extras: DeriveDetailExtras
): ThreadDetail {
	const userIndex = lastUserIndex(messages);
	const turn = messages.slice(userIndex + 1);
	const userMessage = userIndex >= 0 ? messages[userIndex] : undefined;
	let userStart = userMessage?.timestamp ?? null;
	if (userMessage && !Number.isFinite(userStart)) {
		const starts = turn
			.flatMap(partsOf)
			.map((part) =>
				isTool(part) ? readToolTiming(part)?.startedAt : undefined
			)
			.filter((at): at is number => at !== undefined);
		userStart = starts.length > 0 ? Math.min(...starts) : null;
	}
	const progressMarks = progressMarksOf(messages, turn);
	return {
		activity: extras.running ? deriveActivity(turn, extras.nowMs) : null,
		blocker: extras.running ? null : deriveBlocker(turn),
		hasLaterAssistant: turn.some((message) => message.role === "assistant"),
		outcome: extras.running ? null : deriveOutcome(messages, extras.hasOlder),
		progress: deriveProgress(messages),
		progressMarks,
		questionAsks: deriveQuestions(messages, extras),
		userStart,
	};
}
