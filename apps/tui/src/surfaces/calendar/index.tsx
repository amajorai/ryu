/* @jsxImportSource @opentui/react */
// Calendar surface (path /calendar) - mirrors the desktop CalendarPage, which
// renders the scheduled jobs as a calendar/agenda. The terminal keeps it light: the
// same scheduled jobs (GET /heartbeat/jobs) presented as an agenda sorted by name,
// with the cadence (cron expr or "every <interval>") as the leading column and the
// job's run target (workflow or agent) as the subtitle. Where Tasks emphasises the
// last outcome, Calendar emphasises the cadence/what-runs. Enter opens Tasks for the
// run history. Keys are gated on being the focused pane's active tab.

import { useKeyboard } from "@opentui/react";
import { fetchJobs, type ScheduledJob } from "@ryuhq/core-client/schedules";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { ErrorView } from "../../ui/ErrorView.tsx";
import { Loading } from "../../ui/Loading.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";

const VISIBLE_ROWS = 14;

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
	return `agent ${target.agentId}`;
}

function sortByName(a: ScheduledJob, b: ScheduledJob): number {
	return a.name.localeCompare(b.name);
}

function CalendarSurface({ active, paneId }: SurfaceProps) {
	const { target, url, token } = useCore();
	const theme = useTheme();
	const { focusedPaneId, openTab } = useWorkspace();
	const focused = active && focusedPaneId === paneId;

	const [jobs, setJobs] = useState<ScheduledJob[]>([]);
	const [index, setIndex] = useState(0);
	const [loading, setLoading] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Track the latest request so a stale resolve cannot clobber fresh data.
	const reqRef = useRef(0);

	const runLoad = useCallback(() => {
		const reqId = ++reqRef.current;
		setLoading(true);
		setError(null);
		fetchJobs(target)
			.then((next) => {
				if (reqRef.current !== reqId) {
					return;
				}
				const sorted = [...next].sort(sortByName);
				setJobs(sorted);
				setIndex((i) =>
					sorted.length === 0 ? 0 : Math.min(i, sorted.length - 1)
				);
				setLoaded(true);
			})
			.catch((err: unknown) => {
				if (reqRef.current !== reqId) {
					return;
				}
				setError(err instanceof Error ? err.message : String(err));
				setLoaded(true);
			})
			.finally(() => {
				if (reqRef.current === reqId) {
					setLoading(false);
				}
			});
	}, [target]);

	// Lazy load on activation, and reload on node switch (url/token).
	useEffect(() => {
		if (active) {
			runLoad();
		}
	}, [active, runLoad]);

	useKeyboard((key) => {
		if (!focused) {
			return;
		}
		if (key.name === "up" || key.name === "k") {
			setIndex((i) => Math.max(0, i - 1));
		} else if (key.name === "down" || key.name === "j") {
			setIndex((i) => Math.min(Math.max(0, jobs.length - 1), i + 1));
		} else if (key.name === "r") {
			runLoad();
		} else if (key.name === "return") {
			openTab("/tasks");
		}
	});

	const header = (
		<box flexDirection="row" gap={2} paddingBottom={1} paddingLeft={1}>
			<text fg={theme.colors.foreground}>
				<b>Calendar</b>
			</text>
			<text fg={theme.colors.mutedForeground}>
				agenda · ↑↓ nav · Enter open Tasks · r refresh
			</text>
		</box>
	);

	if (loading && !loaded) {
		return (
			<box flexDirection="column" flexGrow={1} paddingTop={1}>
				{header}
				<Loading label="Loading schedule…" />
			</box>
		);
	}

	if (error) {
		return (
			<box flexDirection="column" flexGrow={1} paddingTop={1}>
				{header}
				<ErrorView message={error} />
			</box>
		);
	}

	if (jobs.length === 0) {
		return (
			<box flexDirection="column" flexGrow={1} paddingTop={1}>
				{header}
				<box paddingLeft={1}>
					<Card title="agenda">
						<text fg={theme.colors.mutedForeground}>
							nothing scheduled — schedule a job to see it here
						</text>
					</Card>
				</box>
			</box>
		);
	}

	const selected = Math.min(index, jobs.length - 1);
	const start = Math.max(
		0,
		Math.min(
			selected - Math.floor(VISIBLE_ROWS / 2),
			Math.max(0, jobs.length - VISIBLE_ROWS)
		)
	);
	const visible = jobs.slice(start, start + VISIBLE_ROWS);

	return (
		<box flexDirection="column" flexGrow={1} paddingTop={1}>
			{header}
			<box paddingLeft={1}>
				<Card title="agenda">
					{visible.map((job, i) => (
						<AgendaRow
							job={job}
							key={job.id}
							selected={start + i === selected}
						/>
					))}
					{jobs.length > visible.length ? (
						<text fg={theme.colors.mutedForeground}>
							{`${selected + 1}/${jobs.length}`}
						</text>
					) : null}
				</Card>
			</box>
		</box>
	);
}

function AgendaRow({
	job,
	selected,
}: {
	job: ScheduledJob;
	selected: boolean;
}) {
	const theme = useTheme();
	const cadenceColor = job.enabled
		? theme.colors.info
		: theme.colors.mutedForeground;
	return (
		<box flexDirection="row" gap={1}>
			<text fg={selected ? theme.colors.primary : theme.colors.muted}>
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

/** The Calendar surface module (path /calendar). Registered by the Integrate step. */
export const calendarSurface: SurfaceModule = {
	id: "calendar",
	title: "Calendar",
	match: (path) => path === "/calendar" || path.startsWith("/calendar/"),
	Component: CalendarSurface,
};
