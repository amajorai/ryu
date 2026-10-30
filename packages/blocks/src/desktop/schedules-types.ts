import type { RunStatusTimelineEntry } from "@ryu/ui/components/run-status-timeline";

export type ScheduleOutcome = "success" | "failure";

/** A recorded or projected run shown in a schedule's 24-hour status strip. */
export type ScheduleRun = RunStatusTimelineEntry;

/** A scheduled job, pre-formatted by the container for display. */
export interface ScheduleRow {
	/** When the job runs an agent, its id (shown as a badge); else null. */
	agentId: string | null;
	enabled: boolean;
	id: string;
	/** The latest execution's error, if the last run failed. */
	lastError?: string | null;
	lastOutcome: ScheduleOutcome | null;
	/** Human last-run string, e.g. "2 hours ago" or "Never". */
	lastRunLabel: string;
	name: string;
	/** Runs positioned in the rolling 24-hour status strip, oldest first. */
	recentRuns?: ScheduleRun[];
	/** Human schedule phrase, e.g. "Daily at 8 AM" or "Every hour". */
	scheduleLabel: string;
	/** When the job runs a workflow, its resolved name; else null. */
	workflowName: string | null;
}

export interface AgentOption {
	id: string;
	name: string;
}

export interface WorkflowOption {
	id: string;
	name: string;
}

export type TargetKind = "agent" | "workflow";

export type ScheduleKind =
	| { kind: "every"; interval: string }
	| { kind: "cron"; expr: string };

/** The payload the container persists when the dialog form is submitted. */
export interface CreateSchedulePayload {
	enabled: boolean;
	name: string;
	schedule: ScheduleKind;
	target:
		| { type: "agent"; agentId: string; prompt: string }
		| { type: "workflow"; workflowId: string; input: Record<string, string> };
}

/** Each handler owns its fulfilled result; this view only awaits completion.
 * The default keeps the original unparameterized props ABI broad. */
export interface SchedulesViewProps<Result = unknown> {
	agents: AgentOption[];
	agentsLoading?: boolean;
	error?: string | null;
	jobs: ScheduleRow[];
	loading?: boolean;
	onCreate?: (payload: CreateSchedulePayload) => Promise<Result>;
	onDelete?: (id: string) => void;
	onRetry?: () => void;
	/** Stable clock for previews/tests; live callers can omit it to use now. */
	timelineEndAt?: number;
	workflows: WorkflowOption[];
	workflowsLoading?: boolean;
}
