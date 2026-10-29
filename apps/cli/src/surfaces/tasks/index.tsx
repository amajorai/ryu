/* @jsxImportSource @opentui/react */
// Tasks surface (path /tasks) - mirrors the desktop Tasks/Quests page as a to-do
// oriented view of the work Ryu runs on your behalf.
//
// The screen PREFERS a contributed declarative view: an enabled plugin contributing
// a `views` entry with id "surface:tasks" claims this surface, and the shell renders
// that spec (src/ui/ContributedView.tsx) instead of the built-in list below. Until
// then the hand-written screen stays.
//
// The terminal folds the legacy schedules tab in: the scheduled (heartbeat) jobs
// from GET /heartbeat/jobs, each row showing enabled state, name, cadence, last
// outcome and last-run date. The screen itself is shared with Calendar
// (../ScheduledJobsSurface.tsx); keys: ↑↓/jk navigate, r refreshes.

import type { ScheduledJob } from "@ryuhq/core-client/schedules";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import type { SurfaceModule } from "../../workspace/router.ts";
import {
	type ScheduledJobRowProps,
	scheduledJobsSurface,
} from "../ScheduledJobsSurface.tsx";

const NAME_WIDTH = 20;
const SCHEDULE_WIDTH = 22;
const SURFACE_ID = "tasks";

function scheduleLabel(job: ScheduledJob): string {
	const { schedule } = job;
	if (schedule.kind === "cron") {
		return schedule.expr.length > 0 ? schedule.expr : "—";
	}
	return schedule.interval.length > 0 ? `every ${schedule.interval}` : "—";
}

function lastRunLabel(job: ScheduledJob): string {
	if (!job.lastRunAt) {
		return "—";
	}
	const [date] = job.lastRunAt.split("T");
	return date && date.length > 0 ? date : "—";
}

function pad(value: string, width: number): string {
	return value.length >= width ? value : value.padEnd(width, " ");
}

function JobRow({ job, selected }: ScheduledJobRowProps) {
	const theme = useTheme();
	const enabledIcon = job.enabled ? "●" : "○";
	const enabledColor = job.enabled
		? theme.colors.success
		: theme.colors.mutedForeground;
	let outcomeIcon = "—";
	let outcomeColor = theme.colors.mutedForeground;
	if (job.lastOutcome === "success") {
		outcomeIcon = "✓";
		outcomeColor = theme.colors.success;
	} else if (job.lastOutcome === "failure") {
		outcomeIcon = "✗";
		outcomeColor = theme.colors.error;
	}
	const nameColor = selected ? theme.colors.primary : theme.colors.foreground;
	return (
		<box flexDirection="row" gap={1}>
			<text fg={selected ? theme.colors.primary : theme.colors.mutedForeground}>
				{selected ? "›" : " "}
			</text>
			<text fg={enabledColor}>{enabledIcon}</text>
			<text fg={nameColor}>
				{selected ? (
					<b>{pad(job.name, NAME_WIDTH)}</b>
				) : (
					pad(job.name, NAME_WIDTH)
				)}
			</text>
			<text fg={theme.colors.mutedForeground}>
				{pad(scheduleLabel(job), SCHEDULE_WIDTH)}
			</text>
			<text fg={outcomeColor}>{outcomeIcon}</text>
			<text fg={theme.colors.mutedForeground}>{lastRunLabel(job)}</text>
		</box>
	);
}

const TasksSurface = scheduledJobsSurface({
	cardTitle: "scheduled jobs",
	emptyText: "no scheduled jobs — press r to refresh",
	hint: "scheduled jobs · ↑↓ nav · r refresh",
	loadingLabel: "Loading scheduled jobs…",
	Row: JobRow,
	surfaceId: SURFACE_ID,
	title: "Tasks",
	visibleRows: 16,
});

/** The Tasks surface module (path /tasks). Registered by the Integrate step. */
export const tasksSurface: SurfaceModule = {
	id: SURFACE_ID,
	title: "Tasks",
	match: (path) => path === "/tasks" || path.startsWith("/tasks/"),
	Component: TasksSurface,
};
