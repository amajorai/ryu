import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	hourIndex,
	hourlyCounts,
	hourlyStarts,
	timeOf,
} from "./mission-control-model-hours.ts";
import { buildBanner, buildKpis } from "./mission-control-model-summary.ts";
import type {
	ActivityBucket,
	ActivityRun,
	MissionActivity,
	MissionAgentState,
	MissionAlert,
	MissionStation,
	MissionTapeItem,
	MissionView,
} from "./mission-control-model-types.ts";

export {
	clockDate,
	clockTime,
	countdown,
	countdownTicks,
	runWhen,
	shortTime,
	utcOffsetLabel,
} from "./mission-control-model-format.ts";
export {
	hourIndex,
	hourlyStarts,
	hourStart,
} from "./mission-control-model-hours.ts";
export {
	ACTIVITY_HOURS,
	type ActivityBucket,
	type ActivityRun,
	HOUR_MS,
	type MissionActivity,
	type MissionAgentState,
	type MissionAlert,
	type MissionAlertSeverity,
	type MissionBanner,
	type MissionKpi,
	type MissionKpiId,
	type MissionStation,
	type MissionTapeItem,
	type MissionTone,
	type MissionView,
	ONLINE_WINDOW_MS,
} from "./mission-control-model-types.ts";

/**
 * Mission Control's view model: everything the wall shows, derived from one
 * snapshot at one moment. Pure, so the wall can recompute it on every tick and
 * tests can pin `now`.
 */

const TAPE_LIMIT = 14;
const UPCOMING_LIMIT = 6;
const RECENT_RUNS_LIMIT = 4;

const STATE_FOR_STATUS: Record<ThreadStatus, MissionAgentState> = {
	attention: "alert",
	quiet: "idle",
	waiting: "waiting",
	working: "working",
	"your-turn": "your-turn",
};

export const STATION_STATE_LABELS: Record<MissionAgentState, string> = {
	alert: "Failed",
	idle: "Idle",
	waiting: "Queued",
	working: "Working",
	"your-turn": "Your turn",
};

function byNewest(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

function emptyCounts(): Record<ThreadStatus, number> {
	return { attention: 0, quiet: 0, waiting: 0, working: 0, "your-turn": 0 };
}

/** A thread's display title, never blank. */
export function missionThreadTitle(thread: InterfaceThread): string {
	return thread.title.trim() || "Untitled thread";
}

function activityRuns(
	events: readonly InterfaceEvent[],
	starts: readonly number[]
): ActivityRun[] {
	const runs: ActivityRun[] = [];
	for (const event of events) {
		if (event.kind !== "past" || !event.outcome) {
			continue;
		}
		const hour = hourIndex(starts, timeOf(event.start));
		if (hour >= 0) {
			runs.push({
				at: event.start,
				hour,
				id: event.id,
				outcome: event.outcome,
				title: event.title.trim() || "Scheduled run",
			});
		}
	}
	return runs.sort((a, b) => a.at.localeCompare(b.at));
}

function buildActivity(
	threads: readonly InterfaceThread[],
	events: readonly InterfaceEvent[],
	starts: readonly number[]
): MissionActivity {
	const buckets: ActivityBucket[] = starts.map((start) => ({
		count: 0,
		start,
		threadIds: [],
	}));
	for (const thread of [...threads].sort(byNewest)) {
		const bucket = buckets[hourIndex(starts, timeOf(thread.updatedAt))];
		if (bucket) {
			bucket.count += 1;
			bucket.threadIds.push(thread.id);
		}
	}
	let max = 0;
	let total = 0;
	let peak: ActivityBucket | null = null;
	for (const bucket of buckets) {
		total += bucket.count;
		if (bucket.count > max) {
			max = bucket.count;
			peak = bucket;
		}
	}
	return { buckets, max, peak, runs: activityRuns(events, starts), total };
}

function stationFor(
	agent: InterfaceAgent,
	threads: readonly InterfaceThread[],
	statusOf: ReadonlyMap<string, ThreadStatus>,
	starts: readonly number[]
): MissionStation {
	const own = threads
		.filter((thread) => thread.agentIds.includes(agent.id))
		.sort(byNewest);
	const counts = emptyCounts();
	for (const thread of own) {
		const status = statusOf.get(thread.id) ?? "quiet";
		counts[status] += 1;
	}
	const topStatus =
		THREAD_STATUS_ORDER.find((status) => counts[status] > 0) ?? null;
	let state: MissionAgentState = topStatus
		? STATE_FOR_STATUS[topStatus]
		: "idle";
	// A live run outranks everything else on the station's light.
	if (agent.status === "working" || counts.working > 0) {
		state = "working";
	}
	const focusThread =
		own.find((thread) => statusOf.get(thread.id) === "working") ??
		own.find((thread) => statusOf.get(thread.id) === "attention") ??
		own[0];
	return {
		agent,
		counts,
		focusThread,
		hourly: hourlyCounts(
			starts,
			own.map((thread) => timeOf(thread.updatedAt))
		),
		lastActive: own[0]?.updatedAt ?? null,
		state,
		threadCount: own.length,
	};
}

function runFailedDetail(event: InterfaceEvent): string {
	return event.label
		? `Scheduled run failed · ${event.label}`
		: "Scheduled run failed";
}

function buildAlerts(
	threads: readonly InterfaceThread[],
	events: readonly InterfaceEvent[],
	statusOf: ReadonlyMap<string, ThreadStatus>
): MissionAlert[] {
	const warnings: MissionAlert[] = [];
	const advisories: MissionAlert[] = [];
	for (const thread of threads) {
		const status = statusOf.get(thread.id);
		if (status === "attention") {
			warnings.push({
				agentId: thread.agentIds[0] ?? null,
				at: thread.updatedAt,
				detail:
					thread.runState === "interrupted" ? "Run interrupted" : "Run failed",
				id: `thread:${thread.id}`,
				severity: "warning",
				source: "thread",
				threadId: thread.id,
				title: missionThreadTitle(thread),
			});
		} else if (status === "your-turn") {
			advisories.push({
				agentId: thread.agentIds[0] ?? null,
				at: thread.updatedAt,
				// The sub-header already says it waits on you: show what it said.
				detail: thread.lastMessage?.trim() || "No messages yet",
				id: `thread:${thread.id}`,
				severity: "advisory",
				source: "thread",
				threadId: thread.id,
				title: missionThreadTitle(thread),
			});
		}
	}
	for (const event of events) {
		if (event.kind === "past" && event.outcome === "failure") {
			warnings.push({
				agentId: event.agentId,
				at: event.end ?? event.start,
				detail: runFailedDetail(event),
				id: `run:${event.id}`,
				severity: "warning",
				source: "run",
				threadId: null,
				title: event.title.trim() || "Scheduled run",
			});
		}
	}
	const newest = (a: MissionAlert, b: MissionAlert) =>
		b.at.localeCompare(a.at) || a.id.localeCompare(b.id);
	return [...warnings.sort(newest), ...advisories.sort(newest)];
}

function buildTape(
	threads: readonly InterfaceThread[],
	events: readonly InterfaceEvent[],
	statusOf: ReadonlyMap<string, ThreadStatus>
): MissionTapeItem[] {
	const items: MissionTapeItem[] = [];
	for (const thread of threads) {
		if (Number.isNaN(timeOf(thread.updatedAt))) {
			continue;
		}
		items.push({
			agentId: thread.agentIds[0] ?? null,
			at: thread.updatedAt,
			detail: thread.lastMessage?.trim() || null,
			id: `thread:${thread.id}`,
			mark: statusOf.get(thread.id) ?? "quiet",
			threadId: thread.id,
			title: missionThreadTitle(thread),
		});
	}
	for (const event of events) {
		if (event.kind !== "past" || !event.outcome) {
			continue;
		}
		const at = event.end ?? event.start;
		if (Number.isNaN(timeOf(at))) {
			continue;
		}
		items.push({
			agentId: event.agentId,
			at,
			detail: event.outcome === "failure" ? "Run failed" : "Run completed",
			id: `run:${event.id}`,
			mark: event.outcome,
			threadId: null,
			title: event.title.trim() || "Scheduled run",
		});
	}
	return items
		.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
		.slice(0, TAPE_LIMIT);
}

function buildUpcoming(events: readonly InterfaceEvent[]): InterfaceEvent[] {
	return events
		.filter(
			(event) => event.kind === "upcoming" && !Number.isNaN(timeOf(event.start))
		)
		.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))
		.slice(0, UPCOMING_LIMIT);
}

function runFinishedAt(event: InterfaceEvent): string {
	return event.end ?? event.start;
}

function buildRecentRuns(events: readonly InterfaceEvent[]): InterfaceEvent[] {
	return events
		.filter(
			(event) =>
				event.kind === "past" &&
				event.outcome !== undefined &&
				!Number.isNaN(timeOf(runFinishedAt(event)))
		)
		.sort(
			(a, b) =>
				runFinishedAt(b).localeCompare(runFinishedAt(a)) ||
				a.id.localeCompare(b.id)
		)
		.slice(0, RECENT_RUNS_LIMIT);
}

/** Everything Mission Control shows, for one snapshot at one moment. */
export function buildMissionControl(
	snapshot: InterfaceSnapshot,
	now: number
): MissionView {
	const { threads } = snapshot;
	const events = snapshot.events ?? [];
	const statusOf = new Map<string, ThreadStatus>();
	const counts = emptyCounts();
	for (const thread of threads) {
		const status = threadStatus(thread);
		statusOf.set(thread.id, status);
		counts[status] += 1;
	}
	const starts = hourlyStarts(now);
	const activity = buildActivity(threads, events, starts);
	// Stations keep the snapshot's agent order so a light never moves on the wall.
	const stations = snapshot.agents.map((agent) =>
		stationFor(agent, threads, statusOf, starts)
	);
	const alerts = buildAlerts(threads, events, statusOf);
	const newest = [...threads].sort(byNewest)[0];
	return {
		activity,
		alerts,
		banner: buildBanner(alerts, counts),
		counts,
		kpis: buildKpis({
			activity,
			alerts,
			counts,
			now,
			starts,
			stations,
			statusOf,
			threads,
		}),
		lastUpdate: newest?.updatedAt ?? null,
		recentRuns: buildRecentRuns(events),
		stations,
		tape: buildTape(threads, events, statusOf),
		upcoming: buildUpcoming(events),
	};
}
