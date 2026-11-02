// The live useful-state fields of a thread: run-stream state (1a), usage
// limits, run starts and message-derived detail (1b).

import type {
	InterfaceAgentLimit,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { UsageSnapshot } from "@/src/lib/api/usage.ts";
import {
	resolveLastProgress,
	type ThreadDetail,
} from "@/src/lib/interface-detail.ts";
import { summaryBlocker } from "./snapshot-blockers.ts";
import type { InterfaceLiveInput } from "./snapshot-types.ts";
import {
	activeTranslate,
	type SnapshotTranslate,
	toIso,
} from "./snapshot-util.ts";
import type { InterfaceDetailInput } from "./use-interface-detail.ts";

export function applyLive(
	thread: InterfaceThread,
	status: string | undefined,
	live: InterfaceLiveInput,
	tl: SnapshotTranslate = activeTranslate
): InterfaceThread {
	const firstSeen = live.firstSeenRunning.get(thread.id);
	const terminal = live.terminalSeen.get(thread.id);
	const next: InterfaceThread = {
		...thread,
		detail: "summary",
		unread: live.unread.get(thread.id) ?? 0,
	};
	if (status === "awaiting_input") {
		next.awaitingInput = true;
	}
	if (thread.running && status === "running" && firstSeen !== undefined) {
		next.runStartedAt = toIso(firstSeen);
		next.runStartedApprox = true;
	}
	next.runEndedAt =
		terminal &&
		!terminal.approx &&
		(status === "completed" || status === "failed")
			? toIso(terminal.atMs)
			: null;
	// A parent kept live by a running helper is working, not stopped.
	const blocker = next.running ? null : summaryBlocker(next, terminal, tl);
	if (blocker) {
		next.blocker = blocker;
	}
	return next;
}

// ── Phase 1b: limits, run starts, message detail ─────────────────────────

const NON_ALNUM = /[^a-z0-9]/g;

/** Port of Core's `models_match`: lowercase ASCII alphanumerics, false when
 *  either is empty, else true when either contains the other. */
export function modelsMatch(
	scoped: string | null | undefined,
	model: string | null | undefined
): boolean {
	const a = (scoped ?? "").toLowerCase().replace(NON_ALNUM, "");
	const b = (model ?? "").toLowerCase().replace(NON_ALNUM, "");
	if (!(a && b)) {
		return false;
	}
	return a.includes(b) || b.includes(a);
}

function windowLabel(window: UsageSnapshot["windows"][number]): string {
	return window.model && window.model !== window.label
		? `${window.label} (${window.model})`
		: window.label;
}

/**
 * An agent's limit from its usage snapshot (spec §3.2 `agent.limit`): blocked
 * by an at-100% window that is account-wide or names the agent's model;
 * unknown (null) when the probe failed or a per-model window at 100% cannot be
 * matched to an agent with no model; otherwise the highest-used relevant
 * window. `retry_after_seconds` only means the probe was throttled.
 */
export function chooseAgentLimit(
	usage: UsageSnapshot | null,
	agentModel: string | null
): InterfaceAgentLimit | null {
	if (!usage?.available || usage.reason) {
		return null;
	}
	const relevant = usage.windows.filter(
		(window) => window.model === null || modelsMatch(window.model, agentModel)
	);
	const toLimit = (
		window: UsageSnapshot["windows"][number],
		blocked: boolean
	): InterfaceAgentLimit => ({
		blocked,
		label: windowLabel(window),
		model: window.model,
		resetsAt: window.resetsAt,
		usedPercent: window.usedPercent,
		windowSeconds: window.windowSeconds,
	});
	const full = relevant
		.filter((window) => window.usedPercent >= 100)
		.sort(
			(a, b) =>
				(a.resetsAt ?? "\uffff").localeCompare(b.resetsAt ?? "\uffff") ||
				a.label.localeCompare(b.label)
		);
	if (full[0]) {
		return toLimit(full[0], true);
	}
	const unmatched = usage.windows.some(
		(window) => window.usedPercent >= 100 && window.model !== null
	);
	if (unmatched && !agentModel) {
		return null;
	}
	const highest = [...relevant].sort(
		(a, b) => b.usedPercent - a.usedPercent
	)[0];
	return highest ? toLimit(highest, false) : null;
}

/** A user-message start can predate first sighting by this much and still
 *  belong to this run (clock skew, the first frame's delay). */
const RUN_START_SLACK_MS = 5000;

/**
 * The start of the current run: the last user message's time counts as exact
 * only when it is not older than the first sighting (less 5 s), or no
 * assistant message follows it. Otherwise (a retry re-claiming the run, an
 * agent-to-agent turn) the first sighting stays, approximate.
 */
export function resolveRunStart(
	detailStart: number | null,
	firstSeenMs: number | null,
	hasLaterAssistant: boolean
): { approx: boolean; startMs: number } | null {
	if (detailStart !== null) {
		const fresh =
			firstSeenMs !== null && detailStart >= firstSeenMs - RUN_START_SLACK_MS;
		if (fresh || !hasLaterAssistant) {
			return { approx: false, startMs: detailStart };
		}
	}
	return firstSeenMs === null ? null : { approx: true, startMs: firstSeenMs };
}

/** The derived detail of a conversation the store has read (a newer read may
 *  be in flight; the last good one still describes the thread). */
export function detailOf(
	detail: InterfaceDetailInput | undefined,
	id: string
): ThreadDetail | null {
	return detail?.entries.get(id)?.detail ?? null;
}

export function applyDetail(
	thread: InterfaceThread,
	status: string | undefined,
	live: InterfaceLiveInput,
	detail: InterfaceDetailInput | undefined
): InterfaceThread {
	const entry = detailOf(detail, thread.id);
	const tab = detail?.live.get(thread.id);
	if (!(entry || tab)) {
		return thread;
	}
	const next: InterfaceThread = { ...thread };
	if (entry) {
		next.detail = "detail";
		next.progress = entry.progress ?? next.progress ?? null;
	}
	// Its own run (or an open tab's live turn), not one lifted from a helper:
	// a main kept live only by a helper has no start and no progress of its
	// own, so it is never judged stalled on its previous turn.
	const ownRunning = status === "running" || tab?.running === true;
	if (thread.running && !ownRunning) {
		next.activity = tab?.activity ?? null;
		next.outcome = null;
	} else if (thread.running) {
		const firstSeen = live.firstSeenRunning.get(thread.id) ?? null;
		const start =
			typeof tab?.startedAtMs === "number"
				? { approx: false, startMs: tab.startedAtMs }
				: resolveRunStart(
						entry?.userStart ?? null,
						firstSeen,
						entry?.hasLaterAssistant ?? false
					);
		if (start) {
			next.runStartedAt = toIso(start.startMs);
			next.runStartedApprox = start.approx;
		}
		next.activity = tab?.activity ?? entry?.activity ?? null;
		if (entry || tab?.lastProgressAt) {
			// Floored by this run's start: a retried or agent-to-agent run must not
			// read as stalled from the previous turn's last step.
			const start = next.runStartedAt ? Date.parse(next.runStartedAt) : null;
			const saved = entry
				? resolveLastProgress(entry.progressMarks, start)
				: null;
			next.lastProgressAt =
				tab?.lastProgressAt ??
				(saved === null ? null : toIso(saved)) ??
				next.runStartedAt ??
				null;
		}
		next.outcome = null;
	} else if (entry) {
		next.outcome = entry.outcome
			? { ...entry.outcome, finishedAt: thread.runEndedAt ?? null }
			: null;
		// A saved reason replaces the summary blocker of a run that stopped.
		const stopped =
			thread.runState === "failed" || thread.runState === "interrupted";
		if (stopped && entry.blocker) {
			next.blocker = entry.blocker;
		}
	}
	if (tab?.blocker) {
		next.blocker = tab.blocker;
	}
	return next;
}
