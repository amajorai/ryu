/* @jsxImportSource @opentui/react */
// Calendar surface (path /calendar) - mirrors the desktop CalendarPage, which
// renders the scheduled jobs as a calendar/agenda.
//
// The screen PREFERS the calendar app's own declarative view: an enabled plugin
// contributing a `views` entry with id "surface:calendar" claims this surface, and
// the shell renders that spec (src/ui/ContributedView.tsx) instead of the agenda
// below. Until then the hand-written agenda stays. The terminal keeps it light: the
// same scheduled jobs (GET /heartbeat/jobs) presented as an agenda sorted by name,
// with the cadence (cron expr or "every <interval>") as the leading column and the
// job's run target (workflow or agent) as the subtitle. Where Tasks emphasises the
// last outcome, Calendar emphasises the cadence/what-runs. Enter opens Tasks for the
// run history. The screen itself is shared with Tasks (../ScheduledJobsSurface.tsx).

import {
	type ScheduledJob,
	systemTargetLabel,
} from "@ryuhq/core-client/schedules";
import { Badge } from "@/components/ui/badge.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import type { SurfaceModule } from "../../workspace/router.ts";
import {
	type ScheduledJobRowProps,
	scheduledJobsSurface,
} from "../ScheduledJobsSurface.tsx";

const SURFACE_ID = "calendar";

function cadenceLabel(job: ScheduledJob): string {
	const { schedule } = job;
	if (schedule.kind === "cron") {
		return schedule.expr.length > 0 ? schedule.expr : "cron";
	}
	return schedule.interval.length > 0
		? `every ${schedule.interval}`
		: "interval";
}

function targetLabel(job: ScheduledJob): string {
	const { target } = job;
	if (target.type === "workflow") {
		return `workflow ${target.workflowId}`;
	}
	if (target.type === "system") {
		return systemTargetLabel(target);
	}
	return `agent ${target.agentId}`;
}

function sortByName(a: ScheduledJob, b: ScheduledJob): number {
	return a.name.localeCompare(b.name);
}

function AgendaRow({ job, selected }: ScheduledJobRowProps) {
	const theme = useTheme();
	const cadenceColor = job.enabled
		? theme.colors.info
		: theme.colors.mutedForeground;
	return (
		<box flexDirection="row" gap={1}>
			<text fg={selected ? theme.colors.primary : theme.colors.mutedForeground}>
				{selected ? "›" : " "}
			</text>
			<box flexDirection="column" flexGrow={1}>
				<box flexDirection="row" gap={1}>
					<text fg={selected ? theme.colors.primary : theme.colors.foreground}>
						{selected ? <b>{job.name}</b> : job.name}
					</text>
					<Badge bordered={false} variant="secondary">
						{cadenceLabel(job)}
					</Badge>
					{job.enabled ? null : (
						<Badge bordered={false} variant="warning">
							paused
						</Badge>
					)}
				</box>
				<text fg={cadenceColor}>{targetLabel(job)}</text>
			</box>
		</box>
	);
}

const CalendarSurface = scheduledJobsSurface({
	cardTitle: "agenda",
	emptyText: "nothing scheduled — schedule a job to see it here",
	hint: "agenda · ↑↓ nav · Enter open Tasks · r refresh",
	loadingLabel: "Loading schedule…",
	openPath: "/tasks",
	Row: AgendaRow,
	sort: sortByName,
	surfaceId: SURFACE_ID,
	title: "Calendar",
	visibleRows: 14,
});

/** The Calendar surface module (path /calendar). Registered by the Integrate step. */
export const calendarSurface: SurfaceModule = {
	id: SURFACE_ID,
	title: "Calendar",
	match: (path) => path === "/calendar" || path.startsWith("/calendar/"),
	Component: CalendarSurface,
};
