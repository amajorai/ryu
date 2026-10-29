import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Mission Control's view model: everything the wall shows, derived from one
 * snapshot at one moment. Pure, so the wall can recompute it on every tick and
 * tests can pin `now`.
 */

export const HOUR_MS = 3_600_000;
/** The activity chart and every KPI trend cover this many hours. */
export const ACTIVITY_HOURS = 24;
/** An agent counts as online while working or active within this window. */
export const ONLINE_WINDOW_MS = HOUR_MS;
const TAPE_LIMIT = 14;
const UPCOMING_LIMIT = 6;
const RECENT_RUNS_LIMIT = 4;

/**
 * What a mark's color means on the wall. Each maps to one semantic token:
 * `live` success, `attention` destructive, `advisory` primary, `neutral` muted.
 */
export type MissionTone = "advisory" | "attention" | "live" | "neutral";

export type MissionKpiId =
	| "attention"
	| "online"
	| "today"
	| "waiting"
	| "working"
	| "your-turn";

export interface MissionKpi {
	caption: string;
	id: MissionKpiId;
	label: string;
	tone: MissionTone;
	/** One value per hour, oldest first; the last entry is the current hour. */
	trend: number[];
	/** What a single trend entry counts, for the sparkline's accessible name. */
	trendLabel: string;
	/** The visible micro-caption under the spark: what its columns measure. */
	trendNote: string;
	value: number;
}

export interface ActivityBucket {
	count: number;
	/** Local start of the hour, in epoch milliseconds. */
	start: number;
	/** Threads last updated in this hour, newest first. */
	threadIds: string[];
}

/** A finished scheduled run inside the activity window. */
export interface ActivityRun {
	at: string;
	/** Which hourly bucket it ran in. */
	hour: number;
	id: string;
	outcome: "failure" | "success";
	title: string;
}

export interface MissionActivity {
	buckets: ActivityBucket[];
	max: number;
	peak: ActivityBucket | null;
	/** Finished scheduled runs in the window, oldest first. */
	runs: ActivityRun[];
	total: number;
}

/** A station's state, most urgent first after a live run. */
export type MissionAgentState =
	| "alert"
	| "idle"
	| "waiting"
	| "working"
	| "your-turn";

export interface MissionStation {
	agent: InterfaceAgent;
	counts: Record<ThreadStatus, number>;
	/** The thread the station is "on": live run, else failure, else newest. */
	focusThread: InterfaceThread | undefined;
	/** The agent's thread updates per hour over the activity window. */
	hourly: number[];
	lastActive: string | null;
	state: MissionAgentState;
	threadCount: number;
}

export type MissionAlertSeverity = "advisory" | "warning";

export interface MissionAlert {
	agentId: string | null;
	at: string;
	detail: string;
	id: string;
	severity: MissionAlertSeverity;
	source: "run" | "thread";
	threadId: string | null;
	title: string;
}

export interface MissionTapeItem {
	agentId: string | null;
	at: string;
	detail: string | null;
	id: string;
	/** `success`/`failure` for a scheduled run; a thread status otherwise. */
	mark: "failure" | "success" | ThreadStatus;
	threadId: string | null;
	title: string;
}

export interface MissionBanner {
	detail: string;
	headline: string;
	tone: "attention" | "nominal";
}

export interface MissionView {
	activity: MissionActivity;
	alerts: MissionAlert[];
	banner: MissionBanner;
	counts: Record<ThreadStatus, number>;
	kpis: MissionKpi[];
	/** Newest thread activity anywhere, when there is any. */
	lastUpdate: string | null;
	/** Finished scheduled runs, newest first. */
	recentRuns: InterfaceEvent[];
	stations: MissionStation[];
	tape: MissionTapeItem[];
	upcoming: InterfaceEvent[];
}

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

function timeOf(iso: string | null | undefined): number {
	if (!iso) {
		return Number.NaN;
	}
	return Date.parse(iso);
}

function byNewest(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

function emptyCounts(): Record<ThreadStatus, number> {
	return { attention: 0, quiet: 0, waiting: 0, working: 0, "your-turn": 0 };
}

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** A thread's display title, never blank. */
export function missionThreadTitle(thread: InterfaceThread): string {
	return thread.title.trim() || "Untitled thread";
}

/** Local start of the hour containing `now`. */
export function hourStart(now: number): number {
	const date = new Date(now);
	date.setMinutes(0, 0, 0);
	return date.getTime();
}

/** Hour starts for the trailing window, oldest first, ending with this hour. */
export function hourlyStarts(now: number, hours = ACTIVITY_HOURS): number[] {
	const current = hourStart(now);
	const starts: number[] = [];
	for (let offset = hours - 1; offset >= 0; offset -= 1) {
		starts.push(current - offset * HOUR_MS);
	}
	return starts;
}

/**
 * Which hourly bucket a timestamp falls in, or -1 outside the window. Small
 * clock skew into the future counts as the current hour.
 */
export function hourIndex(starts: readonly number[], at: number): number {
	const first = starts[0];
	if (first === undefined || Number.isNaN(at) || at < first) {
		return -1;
	}
	const last = starts.length - 1;
	return Math.min(last, Math.floor((at - first) / HOUR_MS));
}

function hourlyCounts(
	starts: readonly number[],
	times: Iterable<number>
): number[] {
	const counts = starts.map(() => 0);
	for (const at of times) {
		const index = hourIndex(starts, at);
		if (index >= 0) {
			counts[index] = (counts[index] ?? 0) + 1;
		}
	}
	return counts;
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

function buildBanner(
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

function buildKpis(input: {
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

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** 24-hour wall-clock time, `HH:MM:SS`. */
export function clockTime(at: number): { hours: string; seconds: string } {
	const date = new Date(at);
	return {
		hours: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
		seconds: pad(date.getSeconds()),
	};
}

/** `HH:MM` for a timestamp, or an empty string when it is not a date. */
export function shortTime(iso: string | number): string {
	const at = typeof iso === "number" ? iso : Date.parse(iso);
	if (Number.isNaN(at)) {
		return "";
	}
	const date = new Date(at);
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The local UTC offset, e.g. `UTC+2` or `UTC-5:30`. */
export function utcOffsetLabel(at: number): string {
	const offset = -new Date(at).getTimezoneOffset();
	if (offset === 0) {
		return "UTC";
	}
	const sign = offset > 0 ? "+" : "-";
	const hours = Math.floor(Math.abs(offset) / 60);
	const minutes = Math.abs(offset) % 60;
	return `UTC${sign}${hours}${minutes ? `:${pad(minutes)}` : ""}`;
}

/**
 * Time to a run in one unit style: `59m 56s` within the hour, `5h 20m` within
 * a day, `2d 4h` beyond, and `Due` once it has passed. Seconds only show in
 * the final hour.
 */
export function countdown(target: string, now: number): string {
	const at = Date.parse(target);
	if (Number.isNaN(at)) {
		return "";
	}
	const seconds = Math.floor((at - now) / 1000);
	if (seconds <= 0) {
		return "Due";
	}
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3600);
	if (days > 0) {
		return `${days}d ${hours}h`;
	}
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	return `${minutes}m ${pad(seconds % 60)}s`;
}

/** Whether a countdown to `target` currently shows seconds. */
export function countdownTicks(target: string, now: number): boolean {
	const left = Date.parse(target) - now;
	return left > 0 && left < HOUR_MS;
}

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const DAY_MONTH = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
});

/** `Tue 13 Oct`-style date in the user's locale. */
export function clockDate(at: number): string {
	const date = new Date(at);
	return `${WEEKDAY.format(date)} ${DAY_MONTH.format(date)}`;
}

/** When an upcoming run starts, relative to today: `15:00`, `Tomorrow 09:00`, `Fri 17:00`. */
export function runWhen(start: string, now: number): string {
	const at = Date.parse(start);
	if (Number.isNaN(at)) {
		return "";
	}
	const date = new Date(at);
	const today = new Date(now);
	const time = shortTime(at);
	if (localDayKey(date) === localDayKey(today)) {
		return time;
	}
	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);
	if (localDayKey(date) === localDayKey(tomorrow)) {
		return `Tomorrow ${time}`;
	}
	if (at - now < 6 * 86_400_000) {
		return `${WEEKDAY.format(date)} ${time}`;
	}
	return `${DAY_MONTH.format(date)} ${time}`;
}
