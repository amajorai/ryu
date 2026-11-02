import { activeLocale, dateFormatter } from "@ryu/i18n/lite";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
} from "@ryuhq/protocol/interfaces";

// ---------------------------------------------------------------------------
// Top bar and rail
// ---------------------------------------------------------------------------

export interface PathDay {
	/** Some thread's last turn finished with an outcome that day. */
	active: boolean;
	key: string;
	/** Narrow weekday label ("M", "T", ...). */
	label: string;
	today: boolean;
}

export interface PathStats {
	/** Threads you replied to today, capped at nothing (the ring caps). */
	repliedToday: number;
	/** Consecutive days with an outcome, ending today (or yesterday). */
	streakDays: number;
	/** The last seven days, oldest first. */
	week: PathDay[];
	/** Every message in every thread. */
	xp: number;
}

function addDays(date: Date, days: number): Date {
	const next = new Date(date);
	next.setDate(next.getDate() + days);
	return next;
}

/**
 * When a thread's last turn finished with an outcome: it is not running,
 * the agent spoke last and the run neither failed nor was interrupted. The
 * time is the outcome's `finishedAt`, else `runEndedAt`, else the thread's
 * last update (the answer's last word). Null when there is no outcome.
 */
export function outcomeAt(thread: InterfaceThread): number | null {
	if (
		thread.running ||
		thread.lastMessageRole !== "assistant" ||
		thread.runState === "failed" ||
		thread.runState === "interrupted"
	) {
		return null;
	}
	const time = Date.parse(
		thread.outcome?.finishedAt ?? thread.runEndedAt ?? thread.updatedAt
	);
	return Number.isNaN(time) ? null : time;
}

/** The local days on which some thread's last turn finished with an outcome. */
function outcomeDayKeys(threads: readonly InterfaceThread[]): Set<string> {
	const keys = new Set<string>();
	for (const thread of threads) {
		const time = outcomeAt(thread);
		if (time !== null) {
			keys.add(localDayKey(new Date(time)));
		}
	}
	return keys;
}

/**
 * Days in a row with an outcome (a finished answer, not just messages); a
 * streak survives until today ends.
 */
export function pathStreak(
	threads: readonly InterfaceThread[],
	now: Date
): number {
	const days = outcomeDayKeys(threads);
	let cursor = days.has(localDayKey(now)) ? now : addDays(now, -1);
	let streak = 0;
	while (days.has(localDayKey(cursor))) {
		streak += 1;
		cursor = addDays(cursor, -1);
	}
	return streak;
}

/**
 * A thread counts toward today's goal when it moved today and the last word
 * was yours, or your message started the run that is live now.
 */
export function repliedToday(
	threads: readonly InterfaceThread[],
	now: Date
): number {
	const today = localDayKey(now);
	let count = 0;
	for (const thread of threads) {
		const time = Date.parse(thread.updatedAt);
		if (Number.isNaN(time) || localDayKey(new Date(time)) !== today) {
			continue;
		}
		if (thread.lastMessageRole === "user" || thread.running) {
			count += 1;
		}
	}
	return count;
}

export function pathStats(
	snapshot: InterfaceSnapshot,
	now: Date = new Date(),
	locale: string = activeLocale()
): PathStats {
	const weekday = dateFormatter(locale, { weekday: "narrow" });
	const days = outcomeDayKeys(snapshot.threads);
	const todayKey = localDayKey(now);
	const week: PathDay[] = [];
	for (let offset = -6; offset <= 0; offset += 1) {
		const date = addDays(now, offset);
		const key = localDayKey(date);
		week.push({
			active: days.has(key),
			key,
			label: weekday.format(date),
			today: key === todayKey,
		});
	}
	let xp = 0;
	for (const thread of snapshot.threads) {
		xp += Math.max(0, thread.messageCount);
	}
	return {
		repliedToday: repliedToday(snapshot.threads, now),
		streakDays: pathStreak(snapshot.threads, now),
		week,
		xp,
	};
}

export interface PathLeader {
	agent: InterfaceAgent;
	rank: number;
	threads: number;
	xp: number;
}

/** Agents ranked by messages across the threads they are in. */
export function pathLeaderboard(snapshot: InterfaceSnapshot): PathLeader[] {
	const rows = snapshot.agents.map((agent) => {
		let xp = 0;
		let threads = 0;
		for (const thread of snapshot.threads) {
			if (thread.agentIds.includes(agent.id)) {
				xp += Math.max(0, thread.messageCount);
				threads += 1;
			}
		}
		return { agent, threads, xp };
	});
	rows.sort((a, b) => b.xp - a.xp || a.agent.name.localeCompare(b.agent.name));
	return rows.map((row, position) => ({ ...row, rank: position + 1 }));
}
