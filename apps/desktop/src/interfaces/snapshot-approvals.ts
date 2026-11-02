// Pending Core approvals and the run-state asks (input, reply) as interface
// asks.

import { localizeApproval } from "@ryuhq/core-client/approval-text";
import {
	type InterfaceAsk,
	type InterfaceAskKind,
	type InterfaceThread,
	shortLine,
} from "@ryuhq/protocol/interfaces";
import type { ApprovalRequest } from "@/src/lib/api/approvals.ts";
import { conversationRunStatusMeta } from "@/src/lib/conversation-run-status.ts";
import {
	activeTranslate,
	basename,
	clamp,
	isoOrNull,
	type SnapshotTranslate,
	stringField,
	toIso,
} from "./snapshot-util.ts";

const ASK_TEXT_MAX = 80;
const ASK_REASON_MAX = 160;
const TARGET_MAX = 40;
const WHITESPACE = /\s+/;
const WHITESPACE_RUNS = /\s+/g;

/** Control characters and backticks become spaces, so a target never carries
 *  terminal escapes or markdown into a bubble. */
function stripControl(value: string): string {
	let out = "";
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7f || char === "`" ? " " : char;
	}
	return out;
}

function sanitizeTarget(value: string): string | null {
	const clean = stripControl(value).trim();
	return clean ? clamp(clean.replace(WHITESPACE_RUNS, " "), TARGET_MAX) : null;
}

function urlHost(value: string): string | null {
	try {
		return new URL(value).host || null;
	} catch {
		return null;
	}
}

/**
 * A bounded, sanitised target for a gated tool call, from its arguments: the
 * first two tokens of `command` / `cmd`, the basename of `file_path` / `path` /
 * `notebook_path`, or the host of `url`. Nothing else from the arguments is
 * ever copied. Null for any other shape.
 */
export function approvalTarget(args: unknown): string | null {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return null;
	}
	const record = args as Record<string, unknown>;
	for (const key of ["command", "cmd"]) {
		const value = record[key];
		if (typeof value === "string") {
			const head = stripControl(value)
				.trim()
				.split(WHITESPACE)
				.slice(0, 2)
				.join(" ");
			return sanitizeTarget(head);
		}
	}
	for (const key of ["file_path", "path", "notebook_path"]) {
		const value = record[key];
		if (typeof value === "string") {
			return sanitizeTarget(basename(value));
		}
	}
	const url = record.url;
	if (typeof url === "string") {
		const host = urlHost(url);
		return host ? sanitizeTarget(host) : null;
	}
	return null;
}

/** Where an approval's thread lands in the snapshot. */
export interface ApprovalThreadIndex {
	/** Session conversation id → its parent main thread id. */
	sessionParents: ReadonlyMap<string, string>;
	/** Ids of the snapshot's threads. */
	threadIds: ReadonlySet<string>;
}

const BLOCKING_APPROVALS: ReadonlySet<string> = new Set([
	"tool_call",
	"workflow_gate",
	"scheduled_run",
	"trigger_run",
]);

/**
 * An approval's action as loose fields. Core's action is a union keyed on
 * `type`; the ask mapping only reads the optional fields some variants carry
 * (`host_conversation_id`, `conversation_id`, `agent_id`, `arguments`).
 */
export function approvalActionFields(
	approval: Pick<ApprovalRequest, "action">
): Readonly<Record<string, unknown>> | null {
	return approval.action ?? null;
}

/**
 * A pending Core approval as an interface ask (spec §3.2 mapping table). The
 * question and summary render from the Core messages the request carries
 * (`localizeApproval`) in the reader's locale before they are clamped; a row
 * from an older Core keeps its stored English.
 */
export function approvalToAsk(
	approval: ApprovalRequest,
	index: ApprovalThreadIndex,
	tl: SnapshotTranslate = activeTranslate
): InterfaceAsk {
	const text = localizeApproval(approval, tl);
	const action = approvalActionFields(approval);
	const toolCall = approval.kind === "tool_call";
	const rawThread =
		approval.conversation_id ??
		stringField(action?.host_conversation_id) ??
		stringField(action?.conversation_id);
	let threadId: string | null = null;
	if (rawThread && index.threadIds.has(rawThread)) {
		threadId = rawThread;
	} else if (rawThread) {
		const parent = index.sessionParents.get(rawThread);
		threadId = parent && index.threadIds.has(parent) ? parent : null;
	}
	const ask: InterfaceAsk = {
		agentId: approval.agent_id ?? stringField(action?.agent_id) ?? null,
		blocking: BLOCKING_APPROVALS.has(approval.kind),
		choices: [
			{
				destructive: toolCall,
				id: "approve",
				label: tl("Approve"),
				tone: "allow",
			},
			{
				destructive: false,
				id: "reject",
				label: tl("Reject"),
				tone: "deny",
			},
		],
		holdsRun: approval.kind === "workflow_gate",
		id: `approval:${approval.id}`,
		kind: "approval",
		reason: text.summary ? clamp(text.summary, ASK_REASON_MAX) : null,
		riskTags: [...approval.risk_tags],
		since: isoOrNull(approval.created_at),
		source: "approvals",
		subject: approval.kind,
		target: toolCall ? approvalTarget(action?.arguments) : null,
		text: clamp(text.question || text.title || tl("Approval"), ASK_TEXT_MAX),
		threadId,
	};
	const expiresAt = isoOrNull(approval.expires_at);
	if (expiresAt) {
		ask.expiresAt = expiresAt;
	}
	return ask;
}

export function replyAsk(thread: InterfaceThread): InterfaceAsk | null {
	if (
		thread.lastMessageRole !== "assistant" ||
		thread.running ||
		thread.awaitingInput ||
		thread.runState === "failed" ||
		(thread.unread ?? 0) <= 0
	) {
		return null;
	}
	const text =
		thread.outcome?.headline ||
		(thread.lastMessage ? shortLine(thread.lastMessage, 12) : "") ||
		"Answer ready";
	const exact = thread.runEndedAt ?? null;
	return {
		agentId: thread.agentIds[0] ?? null,
		blocking: false,
		holdsRun: false,
		id: `reply:${thread.id}`,
		kind: "reply",
		since: exact ?? thread.lastMessageAt ?? null,
		sinceApprox: exact === null,
		source: "messages",
		text: clamp(text, ASK_TEXT_MAX),
		threadId: thread.id,
	};
}

export function inputAsk(
	thread: InterfaceThread,
	since: number | undefined
): InterfaceAsk | null {
	if (!thread.awaitingInput) {
		return null;
	}
	const meta = conversationRunStatusMeta("awaiting_input");
	return {
		agentId: thread.agentIds[0] ?? null,
		blocking: true,
		holdsRun: true,
		id: `input:${thread.id}`,
		kind: "input",
		reason: meta?.description ?? null,
		since: since === undefined ? null : toIso(since),
		sinceApprox: true,
		source: "run-stream",
		text: meta?.label ?? "Needs input",
		threadId: thread.id,
	};
}

/** 1a reads no message parts, so it sees no questions at all. */
export const ASK_BLIND_SPOTS_1A: readonly InterfaceAskKind[] = [
	"permission",
	"input",
	"question",
];
