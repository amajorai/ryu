// Interface acts as data. `agentActs`, `askAriaLabel` and `blockerAriaLabel`
// compose English sentences; a host that shows another language renders these
// parts with its own whole messages instead. The English helpers stay as they
// are for SDK consumers that read their strings.

import {
	type ActLineParts,
	type AskAriaParts,
	actLineParts,
	actMsSince,
	askAriaParts,
	askBubbleParts,
	type BlockerAriaParts,
	blockerAriaParts,
} from "./interface-act-ask-parts.ts";
import {
	ACT_SHORT_LINE_WORDS,
	ACT_TRAILING_STOP,
	ACT_WORKING_TITLE_WORDS,
	actAskText,
	actClampWords,
	actFirstWords,
	actParseMs,
	actPlainText,
	type InterfaceAct,
	type InterfaceAgentAct,
	type InterfaceBlockerKind,
	type InterfaceSnapshot,
	type InterfaceThread,
} from "./interfaces.ts";

export * from "./interface-act-ask-parts.ts";

export type ActBubbleParts =
	| { kind: "line"; line: ActLineParts }
	| { blockerKind: InterfaceBlockerKind; kind: "blocker-kind" }
	| { kind: "files-edited"; count: number }
	| { kind: "answer-ready" }
	| { kind: "limit"; backAt: string | null; likely: boolean }
	| { kind: "picking-up" }
	| { kind: "step"; done: number; step: string; total: number }
	| { kind: "working" }
	| { kind: "working-on"; title: string };

export type ActNextParts =
	| { kind: "run"; at: string }
	| { kind: "step"; step: string };

export type ActProgressParts =
	| { kind: "estimate" }
	| { done: number; kind: "steps"; total: number };

export interface AgentActParts {
	act: InterfaceAct;
	/** The carried ask (asking, delivering), as its accessible name reads it. */
	ask: AskAriaParts | null;
	/** Present when the act is blocked on a counted blocker. */
	blocker: BlockerAriaParts | null;
	bubble: ActBubbleParts | null;
	/** Milliseconds the focus run has gone, when its start is exact. */
	elapsedMs: number | null;
	/** Files the delivered thread changed. */
	filesChanged: number;
	helpers: { failed: number; running: number } | null;
	/** limited: the reset time (blocker clearsAt, else the agent's window). */
	limitBackAt: string | null;
	limitWindow: string | null;
	longerThanUsual: boolean;
	name: string;
	next: ActNextParts | null;
	/** The first parked ask's words (null under redaction) and how many wait. */
	parked: { count: number; first: string | null };
	pending: InterfaceAgentAct["pending"];
	progress: ActProgressParts | null;
	redacted: boolean;
	/** Milliseconds since the last progress of a stalled run. */
	stalledMs: number | null;
	/** working: the activity label, or the thread title when there is none. */
	working: { activity: string | null; title: string | null } | null;
}

function workBubbleParts(
	thread: InterfaceThread | undefined,
	act: InterfaceAgentAct,
	redacted: boolean
): ActBubbleParts | null {
	if (!thread) {
		return null;
	}
	const label = thread.activity?.label;
	if (redacted && !label) {
		return { kind: "working" };
	}
	if (label) {
		const line = actLineParts(label, ACT_SHORT_LINE_WORDS, true);
		return line ? { kind: "line", line } : { kind: "working" };
	}
	const progress = act.progress;
	const current = actPlainText(progress?.current);
	if (
		thread.detail === "detail" &&
		current &&
		progress &&
		(progress.kind === "plan" || progress.kind === "workflow")
	) {
		return {
			done: progress.done,
			kind: "step",
			step: actClampWords(current.split(" "), ACT_SHORT_LINE_WORDS - 2),
			total: progress.total,
		};
	}
	return {
		kind: "working-on",
		title: actFirstWords(thread.title, ACT_WORKING_TITLE_WORDS),
	};
}

function bubbleParts(
	act: InterfaceAgentAct,
	thread: InterfaceThread | undefined,
	backAt: string | null,
	redacted: boolean
): ActBubbleParts | null {
	const privacy = redacted ? "redacted" : "full";
	switch (act.act) {
		case "asking":
			return act.ask
				? { kind: "line", line: askBubbleParts(act.ask, privacy) }
				: null;
		case "working":
			return act.stalledFor === null
				? workBubbleParts(thread, act, redacted)
				: null;
		case "blocked": {
			const blocker = act.blockers[0];
			if (!blocker) {
				return null;
			}
			const line = redacted
				? null
				: actLineParts(
						actPlainText(blocker.title).replace(ACT_TRAILING_STOP, "")
					);
			return line
				? { kind: "line", line }
				: { blockerKind: blocker.kind, kind: "blocker-kind" };
		}
		case "limited":
			return {
				backAt,
				kind: "limit",
				likely: act.blockers[0]?.source === "estimate",
			};
		case "delivering": {
			const files = thread?.outcome?.filesChanged ?? 0;
			return files > 0
				? { count: files, kind: "files-edited" }
				: { kind: "answer-ready" };
		}
		case "waiting":
			return { kind: "picking-up" };
		default:
			return null;
	}
}

function nextParts(
	act: InterfaceAgentAct,
	snapshot: InterfaceSnapshot,
	nowMs: number
): ActNextParts | null {
	const step =
		snapshot.privacy === "redacted" ? "" : actPlainText(act.progress?.next);
	if (step) {
		return { kind: "step", step: step.replace(ACT_TRAILING_STOP, "") };
	}
	let soonest: number | null = null;
	for (const event of snapshot.events ?? []) {
		const start = actParseMs(event.start);
		if (
			event.kind === "upcoming" &&
			event.agentId === act.agentId &&
			start !== null &&
			start >= nowMs &&
			(soonest === null || start < soonest)
		) {
			soonest = start;
		}
	}
	return soonest === null
		? null
		: { at: new Date(soonest).toISOString(), kind: "run" };
}

function progressParts(act: InterfaceAgentAct): ActProgressParts | null {
	if (!act.progress) {
		return null;
	}
	return act.progress.kind === "estimate"
		? { kind: "estimate" }
		: { done: act.progress.done, kind: "steps", total: act.progress.total };
}

function workingParts(
	thread: InterfaceThread | undefined,
	redacted: boolean
): AgentActParts["working"] {
	if (redacted || !thread) {
		return { activity: null, title: null };
	}
	const activity = actPlainText(thread.activity?.label).replace(
		ACT_TRAILING_STOP,
		""
	);
	return activity
		? { activity, title: null }
		: { activity: null, title: actPlainText(thread.title) };
}

/**
 * Everything `agentActs` words for one act, as data: the act's own fields
 * plus the snapshot facts its sentences read (the focus thread, the agent's
 * limit window, upcoming runs). Render it with whole messages.
 */
export function agentActParts(
	act: InterfaceAgentAct,
	snapshot: InterfaceSnapshot,
	nowMs: number
): AgentActParts {
	const redacted = snapshot.privacy === "redacted";
	const privacy = redacted ? "redacted" : "full";
	const thread = act.threadId
		? snapshot.threads.find((item) => item.id === act.threadId)
		: undefined;
	const agent = snapshot.agents.find((item) => item.id === act.agentId);
	const focus = act.blockers[0];
	const backAt =
		act.act === "limited"
			? (focus?.clearsAt ?? agent?.limit?.resetsAt ?? null)
			: null;
	const firstParked = act.parkedAsks[0];
	return {
		act: act.act,
		ask: act.ask ? askAriaParts(act.ask, act.agentName, nowMs, privacy) : null,
		blocker:
			act.act === "blocked" && focus
				? blockerAriaParts(focus, act.agentName, nowMs, privacy)
				: null,
		bubble: bubbleParts(act, thread, backAt, redacted),
		elapsedMs:
			act.elapsed === null ? null : actMsSince(thread?.runStartedAt, nowMs),
		filesChanged: thread?.outcome?.filesChanged ?? 0,
		helpers: act.helpers
			? { failed: act.helpers.failed, running: act.helpers.running }
			: null,
		limitBackAt: backAt,
		limitWindow: agent?.limit?.label || null,
		longerThanUsual: act.longerThanUsual,
		name: act.agentName,
		next: nextParts(act, snapshot, nowMs),
		parked: {
			count: act.parkedAsks.length,
			first: firstParked && !redacted ? actAskText(firstParked, false) : null,
		},
		pending: act.pending,
		progress: progressParts(act),
		redacted,
		stalledMs:
			act.stalledFor === null
				? null
				: actMsSince(thread?.lastProgressAt, nowMs),
		working: act.act === "working" ? workingParts(thread, redacted) : null,
	};
}

export {
	actClosed,
	actLowerFirst,
	actPlainText,
} from "./interfaces.ts";
