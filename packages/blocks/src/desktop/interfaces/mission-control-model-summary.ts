import type { LiteralMessage } from "@ryu/i18n/react";
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

export function buildBanner(
	alerts: readonly MissionAlert[],
	counts: Record<ThreadStatus, number>,
	tl: LiteralMessage
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
			parts.push(
				tl("{count, plural, one {# thread} other {# threads}}", {
					count: failedThreads,
				})
			);
		}
		if (failedRuns > 0) {
			parts.push(
				tl("{count, plural, one {# scheduled run} other {# scheduled runs}}", {
					count: failedRuns,
				})
			);
		}
		return {
			detail: parts.join(" · "),
			headline: tl("{count, plural, one {# failure} other {# failures}}", {
				count: warnings,
			}),
			tone: "attention",
		};
	}
	const parts = [tl("{count} working", { count: counts.working })];
	if (counts["your-turn"] > 0) {
		parts.push(tl("{count} your turn", { count: counts["your-turn"] }));
	}
	return {
		detail: parts.join(" · "),
		headline: tl("All systems nominal"),
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
	tl: LiteralMessage;
}): MissionKpi[] {
	const {
		activity,
		alerts,
		counts,
		now,
		starts,
		stations,
		threads,
		statusOf,
		tl,
	} = input;
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
			caption: tl("running now"),
			id: "working",
			label: tl("Working"),
			tone: statusTone(counts.working, "live"),
			trend: trendFor("working"),
			trendLabel: tl("live threads by last update"),
			trendNote: tl("24h · by last update"),
			value: counts.working,
		},
		{
			caption: failures > 0 ? tl("failed") : tl("no failures"),
			id: "attention",
			label: tl("Needs attention"),
			tone: statusTone(failures, "attention"),
			trend: failureTrend,
			trendLabel: tl("failed threads and scheduled runs"),
			trendNote: tl("24h · by last update"),
			value: failures,
		},
		{
			caption:
				counts["your-turn"] > 0 ? tl("replies to read") : tl("all caught up"),
			id: "your-turn",
			label: tl("Your turn"),
			tone: statusTone(counts["your-turn"], "advisory"),
			trend: trendFor("your-turn"),
			trendLabel: tl("threads awaiting you by last update"),
			trendNote: tl("24h · by last update"),
			value: counts["your-turn"],
		},
		{
			caption: tl("awaiting reply"),
			id: "waiting",
			label: tl("Waiting on agent"),
			tone: "neutral",
			trend: trendFor("waiting"),
			trendLabel: tl("threads waiting on an agent by last update"),
			trendNote: tl("24h · by last update"),
			value: counts.waiting,
		},
		{
			caption: tl("of {agentCount} · last 1h", {
				agentCount: String(stations.length),
			}),
			id: "online",
			label: tl("Agents active"),
			tone: statusTone(online, "live"),
			trend: agentsPerHour.map((agents) => agents.size),
			trendLabel: tl("active agents"),
			trendNote: tl("24h · agents active"),
			value: online,
		},
		{
			caption: tl("{count, plural, one {of # thread} other {of # threads}}", {
				count: total,
			}),
			id: "today",
			label: tl("Updated today"),
			tone: "neutral",
			trend: activity.buckets.map((bucket) => bucket.count),
			trendLabel: tl("threads updated"),
			trendNote: tl("24h · updates"),
			value: updatedToday,
		},
	];
}
