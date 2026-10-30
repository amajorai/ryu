import { formatDistanceToNow } from "date-fns";
import type {
	JobTarget,
	Schedule,
	ScheduledJob,
} from "@/src/lib/api/schedules.ts";
import type { buildCalendarEvents } from "@/src/lib/calendar/events.ts";

export type RoutineStatus =
	| "failed"
	| "none"
	| "operational"
	| "paused"
	| "scheduled";

export const STATUS_META = {
	failed: {
		className: "text-status-destructive",
		dotClassName: "bg-destructive",
		label: "Failed",
	},
	none: {
		className: "text-muted-foreground",
		dotClassName: "bg-muted-foreground/45",
		label: "No runs",
	},
	operational: {
		className: "text-status-success",
		dotClassName: "bg-success",
		label: "Operational",
	},
	paused: {
		className: "text-muted-foreground",
		dotClassName: "bg-muted-foreground/50",
		label: "Paused",
	},
	scheduled: {
		className: "text-status-warning",
		dotClassName: "bg-warning",
		label: "Scheduled",
	},
} satisfies Record<
	RoutineStatus,
	{ className: string; dotClassName: string; label: string }
>;

export interface RoutineDraft {
	conversationId: string;
	destination: "new" | "existing";
	enabled: boolean;
	name: string;
	prompt: string;
	requireApproval: boolean;
	scheduleKind: "cron" | "every";
	scheduleValue: string;
	timezone: string;
}

export type EditorMode =
	| { kind: "edit"; job: ScheduledJob }
	| { kind: "new" }
	| null;

export function defaultDraft(): RoutineDraft {
	return {
		conversationId: "",
		destination: "new",
		enabled: true,
		name: "",
		prompt: "",
		requireApproval: false,
		scheduleKind: "every",
		scheduleValue: "1h",
		timezone: "UTC",
	};
}

export function draftFromJob(job: ScheduledJob): RoutineDraft {
	const target = job.target.type === "agent" ? job.target : null;
	return {
		conversationId: target?.conversationId ?? "",
		destination: target?.conversationId ? "existing" : "new",
		enabled: job.enabled,
		name: job.name,
		prompt: target?.prompt ?? "",
		requireApproval: job.requireApproval,
		scheduleKind: job.schedule.kind,
		scheduleValue:
			job.schedule.kind === "cron" ? job.schedule.expr : job.schedule.interval,
		timezone: job.schedule.kind === "cron" ? (job.schedule.tz ?? "UTC") : "UTC",
	};
}

export function statusForJob(
	job: ScheduledJob,
	events: ReturnType<typeof buildCalendarEvents>
): RoutineStatus {
	if (!job.enabled) {
		return "paused";
	}
	const latest = [...job.history].sort(
		(a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)
	)[0];
	if (latest?.outcome === "failure" || job.lastOutcome === "failure") {
		return "failed";
	}
	if (latest?.outcome === "success" || job.lastOutcome === "success") {
		return "operational";
	}
	return events.some((event) => event.kind === "upcoming")
		? "scheduled"
		: "none";
}

export function formatLastRun(job: ScheduledJob): string {
	if (!job.lastRunAt) {
		return "No runs yet";
	}
	const timestamp = Date.parse(job.lastRunAt);
	if (!Number.isFinite(timestamp)) {
		return "Last run unavailable";
	}
	return `Last run ${formatDistanceToNow(new Date(timestamp), { addSuffix: true })}`;
}

export function toSchedule(draft: RoutineDraft): Schedule {
	if (draft.scheduleKind === "cron") {
		return {
			kind: "cron",
			expr: draft.scheduleValue.trim(),
			tz: draft.timezone.trim() || null,
		};
	}
	return { kind: "every", interval: draft.scheduleValue.trim() };
}

export function toTarget(agentId: string, draft: RoutineDraft): JobTarget {
	return {
		type: "agent",
		agentId,
		conversationId:
			draft.destination === "existing" ? draft.conversationId : null,
		prompt: draft.prompt.trim(),
	};
}
