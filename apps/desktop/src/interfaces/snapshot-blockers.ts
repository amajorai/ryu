// The blockers the snapshot derives itself: a failed routine, a stopped run,
// and a hit usage limit. Their titles are written in the reader's locale, so
// templates that embed them ("Likely {title}") read whole.

import {
	agentActs,
	type InterfaceBlocker,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { TerminalSeen } from "./snapshot-types.ts";
import {
	activeTranslate,
	clamp,
	type SnapshotTranslate,
	toIso,
} from "./snapshot-util.ts";

/** Each job's newest past run that failed and belongs to a snapshot thread. */
export function scheduleBlockers(
	events: readonly InterfaceEvent[],
	tl: SnapshotTranslate = activeTranslate
): Map<string, InterfaceBlocker> {
	const newest = new Map<string, InterfaceEvent>();
	for (const event of events) {
		if (event.kind !== "past" || !event.jobId) {
			continue;
		}
		const current = newest.get(event.jobId);
		if (!current || event.start > current.start) {
			newest.set(event.jobId, event);
		}
	}
	const blockers = new Map<string, InterfaceBlocker>();
	for (const event of newest.values()) {
		if (event.outcome !== "failure" || !event.threadId) {
			continue;
		}
		const blocker: InterfaceBlocker = {
			at: event.end ?? null,
			detail: event.error ?? null,
			kind: "schedule-failed",
			source: "schedule",
			title: clamp(tl("{title} failed", { title: event.title }), 40),
		};
		const existing = blockers.get(event.threadId);
		if (!existing || (blocker.at ?? "") > (existing.at ?? "")) {
			blockers.set(event.threadId, blocker);
		}
	}
	return blockers;
}

/** The 1a summary blocker from the run state alone. Never uses updatedAt. */
export function summaryBlocker(
	thread: InterfaceThread,
	terminal: TerminalSeen | undefined,
	tl: SnapshotTranslate = activeTranslate
): InterfaceBlocker | null {
	if (thread.runState === "interrupted") {
		return terminal
			? {
					at: toIso(terminal.atMs),
					atApprox: true,
					kind: "interrupted",
					source: "run-stream",
					title: tl("Interrupted"),
				}
			: {
					at: null,
					kind: "interrupted",
					source: "run-stream",
					title: tl("Interrupted"),
				};
	}
	if (thread.runState === "failed") {
		return {
			at: thread.runEndedAt ?? null,
			kind: "error",
			source: "run-stream",
			title: tl("Run failed"),
		};
	}
	return null;
}

/**
 * The limit-precedence rule (observable conditions only): with the agent's
 * window at 100% now, the focus thread's saved generic error becomes a likely
 * limit when it happened inside the window; a focus thread with no blocker
 * gets the limit itself as its blocker.
 */
export function applyLimitPrecedence(
	snapshot: InterfaceSnapshot,
	nowMs: number,
	tl: SnapshotTranslate = activeTranslate
): InterfaceSnapshot {
	const acts = agentActs(snapshot, nowMs);
	const updates = new Map<string, InterfaceBlocker>();
	for (const agent of snapshot.agents) {
		const limit = agent.limit;
		const focus = acts.get(agent.id)?.threadId;
		const thread = focus
			? snapshot.threads.find((item) => item.id === focus)
			: undefined;
		if (!(limit?.blocked && thread) || thread.running) {
			continue;
		}
		const blocker = thread.blocker;
		if (!blocker) {
			updates.set(thread.id, {
				at: null,
				clearsAt: limit.resetsAt,
				kind: "rate-limited",
				source: "usage",
				title: tl("Limit hit"),
			});
			continue;
		}
		const at = blocker.at ? Date.parse(blocker.at) : Number.NaN;
		const resets = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN;
		const windowMs = (limit.windowSeconds ?? Number.NaN) * 1000;
		const savedGeneric =
			blocker.kind === "error" && blocker.source === "messages";
		if (
			savedGeneric &&
			Number.isFinite(at) &&
			Number.isFinite(resets) &&
			Number.isFinite(windowMs) &&
			at >= resets - windowMs &&
			at <= nowMs
		) {
			updates.set(thread.id, {
				at: blocker.at,
				atApprox: true,
				clearsAt: limit.resetsAt,
				detail: blocker.detail ?? blocker.title,
				kind: "rate-limited",
				source: "estimate",
				title: tl("Limit hit"),
			});
		}
	}
	if (updates.size === 0) {
		return snapshot;
	}
	return {
		...snapshot,
		threads: snapshot.threads.map((thread) => {
			const blocker = updates.get(thread.id);
			return blocker ? { ...thread, blocker } : thread;
		}),
	};
}
