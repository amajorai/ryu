import type {
	InterfaceAgent,
	InterfaceEvent,
	InterfaceThread,
	ThreadStatus,
} from "@ryuhq/protocol/interfaces";

export const HOUR_MS = 3_600_000;
/** The activity chart and every KPI trend cover this many hours. */
export const ACTIVITY_HOURS = 24;
/** An agent counts as online while working or active within this window. */
export const ONLINE_WINDOW_MS = HOUR_MS;

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
