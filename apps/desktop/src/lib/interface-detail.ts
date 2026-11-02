// What a thread's saved message parts say about it, for the interface
// snapshot (spec docs/interfaces-useful-state.md §3.2, phase 1b): the current
// step, plan or workflow progress, why it stopped, what the last finished turn
// produced, and the Question cards still open. Pure: the hydration loop feeds
// it the newest message page of a thread.

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
	type InterfaceOutcome,
	type InterfaceProgress,
	stepKindForTool,
} from "@ryuhq/protocol/interfaces";
import { extractArtifacts } from "@/src/lib/artifacts.ts";
import {
	buildMissionDigest,
	type MissionStreamMessage,
	toolNameOf,
} from "@/src/lib/mission-control/turn-groups.ts";
import { deriveTodoProgress } from "@/src/lib/todo-progress.ts";
import { deriveBlocker } from "./interface-detail-blocker.ts";
import {
	basename,
	clamp,
	DETAIL_MAX,
	iso,
	isTool,
	LABEL_MAX,
	lastWhere,
	partsOf,
	RECENT_STEPS,
	stringIn,
	toolDisplayName,
} from "./interface-detail-parts.ts";
import { deriveQuestions } from "./interface-detail-questions.ts";
import type {
	DeriveDetailExtras,
	DetailMessage,
	ProgressMarks,
	ThreadDetail,
} from "./interface-detail-types.ts";

export { errorCodeKind } from "./interface-detail-blocker.ts";
export { QUESTION_WAIT_MS } from "./interface-detail-parts.ts";
export type {
	DeriveDetailExtras,
	DetailMessage,
	ProgressMarks,
	ThreadDetail,
} from "./interface-detail-types.ts";

/** Revision of a conversation as the detail store sees it. */
export function interfaceDetailRevision(input: {
	messageCount: number;
	runStatus: string | undefined;
	updatedAt: number;
}): string {
	return `${input.updatedAt}:${input.messageCount}:${input.runStatus ?? ""}`;
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
