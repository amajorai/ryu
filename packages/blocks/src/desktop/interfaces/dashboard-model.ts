import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

export type {
	DashboardLayout,
	LayoutItem,
	WidgetId,
	WidgetKind,
	WidgetSize,
	WidgetSpec,
} from "./dashboard-model-layout.ts";
export {
	addWidget,
	availableWidgets,
	cycleWidgetSize,
	DASHBOARD_LAYOUT_KEY,
	DEFAULT_LAYOUT,
	isWidgetId,
	moveWidget,
	nextWidgetSize,
	parseLayout,
	removeWidget,
	sameLayout,
	serializeLayout,
	WIDGET_SIZE_NAMES,
	WIDGET_SIZE_ORDER,
	WIDGET_SIZE_SHORT,
	WIDGETS,
	widgetSpec,
} from "./dashboard-model-layout.ts";

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const ACTIVITY_HOURS = 24;
/** Failed scheduled runs stay on "Needs attention" for a week. */
const FAILED_RUN_WINDOW_MS = 7 * DAY_MS;

export interface ActivityBucket {
	count: number;
	/** Local start of the hour, in ms. */
	start: number;
	/** Threads last updated in this hour, newest first. */
	threadIds: string[];
}

export interface DashboardActivity {
	buckets: ActivityBucket[];
	max: number;
	/** The busiest hour (latest one on a tie), or null with no activity. */
	peak: ActivityBucket | null;
	total: number;
}

export interface DashboardAgentRow {
	agent: InterfaceAgent;
	/** The agent's most recently updated thread. */
	latest: InterfaceThread | null;
	threadCount: number;
	yourTurn: number;
}

export interface DashboardStats {
	agents: number;
	agentsWorking: number;
	attention: number;
	failedRuns: number;
	scheduled24h: number;
	threads: number;
	updated24h: number;
	working: number;
	yourTurn: number;
}

export interface DashboardView {
	activity: DashboardActivity;
	agents: DashboardAgentRow[];
	byStatus: Record<ThreadStatus, InterfaceThread[]>;
	/** Scheduled runs that failed in the last week, newest first. */
	failedRuns: InterfaceEvent[];
	pinned: InterfaceThread[];
	recent: InterfaceThread[];
	stats: DashboardStats;
	/** Projected runs from now on, soonest first; null when the host has no schedules. */
	upcoming: InterfaceEvent[] | null;
}

function timeOf(iso: string): number {
	const value = Date.parse(iso);
	return Number.isNaN(value) ? 0 : value;
}

export function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return timeOf(b.updatedAt) - timeOf(a.updatedAt) || a.id.localeCompare(b.id);
}

/** Local start of the hour that contains `time`. */
export function hourStart(time: number): number {
	const date = new Date(time);
	date.setMinutes(0, 0, 0);
	return date.getTime();
}

/** Twenty-four local hours ending with the current one, oldest first. */
export function buildActivity(
	threads: readonly InterfaceThread[],
	now: number
): DashboardActivity {
	const current = hourStart(now);
	const buckets: ActivityBucket[] = [];
	for (let index = ACTIVITY_HOURS - 1; index >= 0; index -= 1) {
		buckets.push({ count: 0, start: current - index * HOUR_MS, threadIds: [] });
	}
	const first = buckets[0]?.start ?? current;
	for (const thread of [...threads].sort(byRecency)) {
		const at = timeOf(thread.updatedAt);
		if (at < first || at > now + MINUTE_MS) {
			continue;
		}
		const index = Math.min(
			ACTIVITY_HOURS - 1,
			Math.floor((hourStart(at) - first) / HOUR_MS)
		);
		const bucket = buckets[index];
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
		if (bucket.count > 0 && bucket.count >= max) {
			max = bucket.count;
			peak = bucket;
		}
	}
	return { buckets, max, peak, total };
}

/** Clean axis ticks for a count scale: top, middle, zero. */
export function activityTicks(max: number): [number, number, number] {
	const top = Math.max(2, Math.ceil(max / 2) * 2);
	return [top, top / 2, 0];
}

function buildAgents(snapshot: InterfaceSnapshot): DashboardAgentRow[] {
	const sorted = [...snapshot.threads].sort(byRecency);
	const rows = snapshot.agents.map((agent) => {
		const mine = sorted.filter((thread) => thread.agentIds.includes(agent.id));
		return {
			agent,
			latest: mine[0] ?? null,
			threadCount: mine.length,
			yourTurn: mine.filter((thread) => threadStatus(thread) === "your-turn")
				.length,
		};
	});
	return rows.sort(
		(a, b) =>
			Number(b.agent.status === "working") -
				Number(a.agent.status === "working") ||
			timeOf(b.latest?.updatedAt ?? "") - timeOf(a.latest?.updatedAt ?? "") ||
			a.agent.name.localeCompare(b.agent.name)
	);
}

export function buildDashboard(
	snapshot: InterfaceSnapshot,
	now: number
): DashboardView {
	const recent = [...snapshot.threads].sort(byRecency);
	const byStatus = Object.fromEntries(
		THREAD_STATUS_ORDER.map((status) => [status, [] as InterfaceThread[]])
	) as Record<ThreadStatus, InterfaceThread[]>;
	for (const thread of recent) {
		byStatus[threadStatus(thread)].push(thread);
	}
	const upcoming = snapshot.events
		? snapshot.events
				.filter(
					(event) => event.kind === "upcoming" && timeOf(event.start) >= now
				)
				.sort((a, b) => timeOf(a.start) - timeOf(b.start))
		: null;
	const failedRuns = (snapshot.events ?? [])
		.filter(
			(event) =>
				event.kind === "past" &&
				event.outcome === "failure" &&
				now - timeOf(event.start) < FAILED_RUN_WINDOW_MS
		)
		.sort((a, b) => timeOf(b.start) - timeOf(a.start));
	const updated24h = recent.filter(
		(thread) => now - timeOf(thread.updatedAt) < DAY_MS
	).length;
	let scheduled24h = 0;
	for (const event of upcoming ?? []) {
		if (timeOf(event.start) - now < DAY_MS) {
			scheduled24h += Math.max(1, event.count ?? 1);
		}
	}
	return {
		activity: buildActivity(snapshot.threads, now),
		agents: buildAgents(snapshot),
		byStatus,
		failedRuns,
		pinned: recent.filter((thread) => thread.pinned),
		recent,
		stats: {
			agents: snapshot.agents.length,
			agentsWorking: snapshot.agents.filter(
				(agent) => agent.status === "working"
			).length,
			attention: byStatus.attention.length,
			failedRuns: failedRuns.length,
			scheduled24h,
			threads: recent.length,
			updated24h,
			working: byStatus.working.length,
			yourTurn: byStatus["your-turn"].length,
		},
		upcoming,
	};
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** A thread title that is never blank. */
export function threadTitle(thread: InterfaceThread): string {
	return thread.title.trim() || "Untitled thread";
}

/** "in 45m", "in 3h", "in 2d" for a future time; "now" once it is due. */
export function untilLabel(iso: string, now: number): string {
	const delta = timeOf(iso) - now;
	if (delta < MINUTE_MS) {
		return "now";
	}
	// Floor, so a run 59m 58s away reads "in 59m", never "in 60m".
	if (delta < HOUR_MS) {
		return `in ${Math.floor(delta / MINUTE_MS)}m`;
	}
	if (delta < DAY_MS) {
		return `in ${Math.floor(delta / HOUR_MS)}h`;
	}
	return `in ${Math.floor(delta / DAY_MS)}d`;
}

const HOUR_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});
const FULL_FORMAT = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

/** "3 PM" in the viewer's locale. */
export function hourLabel(time: number): string {
	return HOUR_FORMAT.format(time);
}

/** "3:05 PM" in the viewer's locale. */
export function clockLabel(time: number): string {
	return TIME_FORMAT.format(time);
}

/** A full local date and time, for titles and screen readers. */
export function fullDateLabel(iso: string): string {
	const time = timeOf(iso);
	return time ? FULL_FORMAT.format(time) : "";
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}
