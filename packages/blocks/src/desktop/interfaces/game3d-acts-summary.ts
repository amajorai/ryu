import { translate as tr } from "@ryu/i18n/lite";
import {
	compareAsks,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceBlocker,
	type InterfaceSnapshot,
	type InterfaceThread,
	waitBand,
} from "@ryuhq/protocol/interfaces";
import type { ActTotals } from "./game3d-acts.ts";
import { askBubble, blockerKindWord } from "./interface-act-messages.ts";

/** The act layer's summary line, blocker entries and polite announcements. */

/**
 * "3 need you · 2 working · 1 failed · 1 limited" (+ " · 1 stalled?").
 * Zero terms are left out; all zero reads "Nothing running", never "all
 * clear" (a host may have blind spots).
 */
export function actSummaryLine(totals: ActTotals): string {
	const terms: string[] = [];
	if (totals.needYou > 0) {
		terms.push(tr("{count} need you", { count: totals.needYou }));
	}
	if (totals.working > 0) {
		terms.push(tr("{count} working", { count: totals.working }));
	}
	if (totals.failed > 0) {
		terms.push(tr("{count} failed", { count: totals.failed }));
	}
	if (totals.limited > 0) {
		terms.push(tr("{count} limited", { count: totals.limited }));
	}
	if (totals.stalled > 0) {
		terms.push(tr("{count} stalled?", { count: totals.stalled }));
	}
	return terms.length > 0 ? terms.join(" · ") : tr("Nothing running");
}

/** What the announcer has already said. */
export interface AnnounceState {
	/** Blocking ask ids already seen. */
	asks: Set<string>;
	/** Thread ids with a counted blocker already announced. */
	blockerThreads: Set<string>;
	/** Ask ids already announced (or first seen) as expiring. */
	expiring: Set<string>;
}

const MAX_CLAUSES = 3;

/** One counted blocker, with the thread it stopped and its agent. */
export interface BlockerEntry {
	agentId: string;
	agentName: string;
	blocker: InterfaceBlocker;
	threadId: string;
}

function atMs(blocker: InterfaceBlocker): number {
	return blocker.at ? Date.parse(blocker.at) : Number.NEGATIVE_INFINITY;
}

/**
 * Every counted blocker of every agent (on stage or not) with its thread,
 * newest `at` first (unknown times last): the "runs stopped" group and the
 * blocker card's lookups.
 */
export function blockerEntries(
	snapshot: Pick<InterfaceSnapshot, "threads">,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): BlockerEntry[] {
	const entries: BlockerEntry[] = [];
	const used = new Set<string>();
	for (const act of acts.values()) {
		for (const blocker of act.blockers) {
			const thread =
				snapshot.threads.find(
					(item) => item.blocker === blocker && !used.has(item.id)
				) ??
				snapshot.threads.find(
					(item) =>
						!used.has(item.id) &&
						item.blocker &&
						item.agentIds.includes(act.agentId) &&
						item.blocker.kind === blocker.kind &&
						item.blocker.title === blocker.title &&
						(item.blocker.at ?? null) === (blocker.at ?? null)
				);
			if (!thread) {
				continue;
			}
			used.add(thread.id);
			entries.push({
				agentId: act.agentId,
				agentName: act.agentName,
				blocker,
				threadId: thread.id,
			});
		}
	}
	return entries.sort((a, b) => {
		const order = atMs(b.blocker) - atMs(a.blocker);
		if (order !== 0 && !Number.isNaN(order)) {
			return order;
		}
		return a.threadId < b.threadId ? -1 : 1;
	});
}

/** Two blockers say the same thing (kind, title, time, source, clearsAt). */
function sameBlocker(a: InterfaceBlocker, b: InterfaceBlocker): boolean {
	return (
		a.kind === b.kind &&
		a.title === b.title &&
		(a.at ?? null) === (b.at ?? null) &&
		(a.source ?? null) === (b.source ?? null) &&
		(a.clearsAt ?? null) === (b.clearsAt ?? null)
	);
}

/**
 * Whether `thread`'s blocker is one of `act`'s counted blockers, by value:
 * snapshot objects must never be compared by identity across renders (an
 * act and a thread can come from different snapshots). With `claims`
 * (`threadClaims(snapshot)`), the thread must also be the agent's own.
 */
export function actHasBlocker(
	act: Pick<InterfaceAgentAct, "agentId" | "blockers">,
	thread: Pick<InterfaceThread, "blocker" | "id">,
	claims?: ReadonlyMap<string, string>
): boolean {
	const blocker = thread.blocker;
	if (!blocker) {
		return false;
	}
	if (claims && claims.get(thread.id) !== act.agentId) {
		return false;
	}
	return act.blockers.some(
		(item) => item === blocker || sameBlocker(item, blocker)
	);
}

/** Every counted blocker's thread that is not running again. */
export function countedBlockerThreads(
	snapshot: Pick<InterfaceSnapshot, "threads">,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): Map<string, { agentName: string; blocker: InterfaceBlocker }> {
	const found = new Map<
		string,
		{ agentName: string; blocker: InterfaceBlocker }
	>();
	for (const entry of blockerEntries(snapshot, acts)) {
		const thread = snapshot.threads.find((item) => item.id === entry.threadId);
		if (thread && !thread.running) {
			found.set(entry.threadId, {
				agentName: entry.agentName,
				blocker: entry.blocker,
			});
		}
	}
	return found;
}

/** Who an ask belongs to, by name ("Inbox" when no agent owns it). */
function askOwnerName(
	ask: InterfaceAsk,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): string {
	for (const act of acts.values()) {
		if (
			act.ask?.id === ask.id ||
			act.parkedAsks.some((item) => item.id === ask.id)
		) {
			return act.agentName;
		}
	}
	if (ask.agentId) {
		const owner = acts.get(ask.agentId);
		if (owner) {
			return owner.agentName;
		}
	}
	return tr("Inbox");
}

/**
 * The act announcement for this snapshot (or tick): one polite sentence
 * of what is new since `prev`, in order: new blocking asks, threads that
 * newly stopped, and asks that just entered their last 2 minutes. At most
 * 3 clauses joined by "; " plus "+N more". Silent on the first call
 * (`prev` null). A blocker is keyed by its thread, so a richer re-read of
 * the same failure is not announced again; a thread that runs again is
 * forgotten, so its next failure is. Suggestions and replies never speak.
 */
export function actAnnouncement(
	prev: AnnounceState | null,
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	unowned: readonly InterfaceAsk[],
	snapshot: Pick<InterfaceSnapshot, "asks" | "threads">,
	nowMs: number,
	privacy: "full" | "redacted" = "full"
): { sentence: string | null; state: AnnounceState } {
	const blocking = (snapshot.asks ?? []).filter((ask) => ask.blocking);
	for (const ask of unowned) {
		if (ask.blocking && !blocking.some((item) => item.id === ask.id)) {
			blocking.push(ask);
		}
	}
	blocking.sort(compareAsks);
	const stopped = countedBlockerThreads(snapshot, acts);
	const expiringNow = (ask: InterfaceAsk) =>
		waitBand(
			ask.since ? Date.parse(ask.since) : null,
			nowMs,
			ask.expiresAt ? Date.parse(ask.expiresAt) : null
		) === "expiring";
	const state: AnnounceState = {
		asks: new Set(blocking.map((ask) => ask.id)),
		blockerThreads: new Set(stopped.keys()),
		expiring: new Set(),
	};
	const clauses: string[] = [];
	const expiring: string[] = [];
	for (const ask of blocking) {
		const seen = prev?.asks.has(ask.id) ?? true;
		const wasExpiring = prev?.expiring.has(ask.id) ?? false;
		if (expiringNow(ask) || wasExpiring) {
			state.expiring.add(ask.id);
		}
		if (prev === null) {
			continue;
		}
		const name = askOwnerName(ask, acts);
		if (!seen) {
			clauses.push(
				tr("{name} asks: {ask}", {
					ask: askBubble(ask, privacy),
					name,
				})
			);
		} else if (expiringNow(ask) && !wasExpiring) {
			expiring.push(tr("{name}'s ask expires soon", { name }));
		}
	}
	if (prev !== null) {
		for (const [threadId, { agentName, blocker }] of stopped) {
			if (!prev.blockerThreads.has(threadId)) {
				const words =
					privacy === "redacted"
						? blockerKindWord(blocker.kind)
						: blocker.title;
				clauses.push(tr("{name}: {words}", { name: agentName, words }));
			}
		}
	}
	clauses.push(...expiring);
	if (clauses.length === 0) {
		return { sentence: null, state };
	}
	const shown = clauses.slice(0, MAX_CLAUSES);
	const more = clauses.length - shown.length;
	return {
		sentence:
			more > 0
				? tr("{clauses}; +{count} more", {
						clauses: shown.join("; "),
						count: more,
					})
				: shown.join("; "),
		state,
	};
}
