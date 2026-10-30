import {
	type InterfaceThread,
	localDayKey,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	hourIndex,
	hourlyCounts,
	timeOf,
} from "./mission-control-model-hours.ts";
import {
	type MissionActivity,
	type MissionAlert,
	type MissionBanner,
	type MissionKpi,
	type MissionStation,
	type MissionTone,
	ONLINE_WINDOW_MS,
} from "./mission-control-model-types.ts";

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

export function buildBanner(
	alerts: readonly MissionAlert[],
	counts: Record<ThreadStatus, number>
): MissionBanner {
	const failedThreads = alerts.filter(
		(alert) => alert.severity === "warning" && alert.source === "thread"
	).length;
	const failedRuns = alerts.filter(
		(alert) => alert.severity === "warning" && alert.source === "run"
	).length;
	const warnings = failedThreads + failedRuns;
	if (warnings > 0) {
		const parts: string[] = [];
		if (failedThreads > 0) {
			parts.push(plural(failedThreads, "thread"));
		}
		if (failedRuns > 0) {
			parts.push(plural(failedRuns, "scheduled run"));
		}
		return {
			detail: parts.join(" · "),
			headline: plural(warnings, "failure"),
			tone: "attention",
		};
	}
	const parts = [`${counts.working} working`];
	if (counts["your-turn"] > 0) {
		parts.push(`${counts["your-turn"]} your turn`);
	}
	return {
		detail: parts.join(" · "),
		headline: "All systems nominal",
		tone: "nominal",
	};
}

function statusTone(value: number, tone: MissionTone): MissionTone {
	return value > 0 ? tone : "neutral";
}

export function buildKpis(input: {
	activity: MissionActivity;
	alerts: readonly MissionAlert[];
	counts: Record<ThreadStatus, number>;
	now: number;
	starts: readonly number[];
	stations: readonly MissionStation[];
	threads: readonly InterfaceThread[];
	statusOf: ReadonlyMap<string, ThreadStatus>;
}): MissionKpi[] {
	const { activity, alerts, counts, now, starts, stations, threads, statusOf } =
		input;
	const trendFor = (status: ThreadStatus) =>
		hourlyCounts(
			starts,
			threads
				.filter((thread) => statusOf.get(thread.id) === status)
				.map((thread) => timeOf(thread.updatedAt))
		);
	const online = stations.filter(
		(station) =>
			station.state === "working" ||
			now - timeOf(station.lastActive) <= ONLINE_WINDOW_MS
	).length;
	const agentsPerHour = starts.map(() => new Set<string>());
	for (const thread of threads) {
		const index = hourIndex(starts, timeOf(thread.updatedAt));
		for (const agentId of thread.agentIds) {
			agentsPerHour[index]?.add(agentId);
		}
	}
	const today = localDayKey(new Date(now));
	const updatedToday = threads.filter((thread) => {
		const at = timeOf(thread.updatedAt);
		return !Number.isNaN(at) && localDayKey(new Date(at)) === today;
	}).length;
	const total = threads.length;
	// Failed scheduled runs count as alarms too, so this figure, the banner and
	// the alerts panel always agree.
	const failures = alerts.filter(
		(alert) => alert.severity === "warning"
	).length;
	const failureTrend = trendFor("attention");
	for (const run of activity.runs) {
		const current = failureTrend[run.hour];
		if (run.outcome === "failure" && current !== undefined) {
			failureTrend[run.hour] = current + 1;
		}
	}
	return [
		{
			caption: "running now",
			id: "working",
			label: "Working",
			tone: statusTone(counts.working, "live"),
			trend: trendFor("working"),
			trendLabel: "live threads by last update",
			trendNote: "24h · by last update",
			value: counts.working,
		},
		{
			caption: failures > 0 ? "failed" : "no failures",
			id: "attention",
			label: "Needs attention",
			tone: statusTone(failures, "attention"),
			trend: failureTrend,
			trendLabel: "failed threads and scheduled runs",
			trendNote: "24h · by last update",
			value: failures,
		},
		{
			caption: counts["your-turn"] > 0 ? "replies to read" : "all caught up",
			id: "your-turn",
			label: "Your turn",
			tone: statusTone(counts["your-turn"], "advisory"),
			trend: trendFor("your-turn"),
			trendLabel: "threads awaiting you by last update",
			trendNote: "24h · by last update",
			value: counts["your-turn"],
		},
		{
			caption: "awaiting reply",
			id: "waiting",
			label: "Waiting on agent",
			tone: "neutral",
			trend: trendFor("waiting"),
			trendLabel: "threads waiting on an agent by last update",
			trendNote: "24h · by last update",
			value: counts.waiting,
		},
		{
			caption: `of ${stations.length} · last 1h`,
			id: "online",
			label: "Agents active",
			tone: statusTone(online, "live"),
			trend: agentsPerHour.map((agents) => agents.size),
			trendLabel: "active agents",
			trendNote: "24h · agents active",
			value: online,
		},
		{
			caption: `of ${plural(total, "thread")}`,
			id: "today",
			label: "Updated today",
			tone: "neutral",
			trend: activity.buckets.map((bucket) => bucket.count),
			trendLabel: "threads updated",
			trendNote: "24h · updates",
			value: updatedToday,
		},
	];
}
