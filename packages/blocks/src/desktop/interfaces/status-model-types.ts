import type {
	InterfaceAgent,
	InterfaceGroup,
} from "@ryuhq/protocol/interfaces";

export type ComponentState = "degraded" | "operational" | "working";
export type DayLevel = "degraded" | "operational" | "outage";
export type OverallState = "degraded" | "operational" | "partial";
export type IncidentSeverity = "degraded" | "outage";

export const COMPONENT_STATE_LABELS: Record<ComponentState, string> = {
	degraded: "Degraded performance",
	operational: "Operational",
	working: "Working",
};

export const OVERALL_LABELS: Record<OverallState, string> = {
	degraded: "Degraded performance",
	operational: "All systems operational",
	partial: "Partial outage",
};

export const DAY_LEVEL_LABELS: Record<DayLevel, string> = {
	degraded: "Partial outage",
	operational: "No downtime recorded",
	outage: "Outage",
};

/** One day of one component's history. */
export interface UptimeDay {
	/** Threads with activity that day. */
	active: number;
	/** Local `YYYY-MM-DD`. */
	key: string;
	level: DayLevel;
	/** Titles of the failed or interrupted work that day, newest first. */
	problems: string[];
	/** Local midnight that starts the day. */
	start: number;
	/** Scheduled runs that finished cleanly that day. */
	successfulRuns: number;
}

export interface StatusComponent {
	agent: InterfaceAgent;
	/** Oldest first, ending today. */
	days: UptimeDay[];
	state: ComponentState;
	/** Share of the window without failures, 0 to 1. */
	uptime: number;
}

export interface StatusSection {
	components: StatusComponent[];
	/** The team, or null for components outside every team. */
	group: InterfaceGroup | null;
	state: ComponentState;
}

export interface StatusIncident {
	/** Names of the affected components (agents), empty when none. */
	affected: string[];
	agentIds: string[];
	/** RFC 3339 time the incident began (the failure). */
	at: string;
	/** The latest update, in the incident's own words when there are any. */
	body: string;
	id: string;
	kind: "run" | "thread";
	/** Present when the incident is resolved: when the next run succeeded. */
	resolvedAt: string | null;
	/** The routine's schedule phrase, for scheduled-run incidents. */
	schedule: string | null;
	severity: IncidentSeverity;
	/** The word that leads the latest update ("Failed", "Interrupted"...). */
	stage: string;
	/** The thread to open, for thread incidents. */
	threadId: string | null;
	title: string;
}

export interface StatusMaintenance {
	affected: string | null;
	count: number | null;
	id: string;
	schedule: string | null;
	start: string;
	title: string;
}

export interface StatusHistoryDay {
	incidents: StatusIncident[];
	key: string;
	start: number;
}

export interface StatusPage {
	history: StatusHistoryDay[];
	/** Open incidents, newest first. */
	incidents: StatusIncident[];
	maintenance: StatusMaintenance[];
	overall: OverallState;
	sections: StatusSection[];
}
