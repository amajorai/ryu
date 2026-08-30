// apps/desktop/src/components/calendar/AgendaView.tsx
//
// Agenda view for the Calendar page: a chronological list of scheduled runs
// grouped by day, skipping days with nothing on them. Modelled on the agenda
// mode of origin-space/event-calendar.

import { CalendarCheckIn01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	RunStatusTimeline,
	RunStatusTimelineLegend,
} from "@ryu/ui/components/run-status-timeline";
import { cn } from "@ryu/ui/lib/utils";
import { addDays, format, isToday, startOfDay } from "date-fns";
import { EventRow } from "@/src/components/calendar/event-display.tsx";
import type { ScheduledJob } from "@/src/lib/api/schedules.ts";
import {
	buildRunStatusTimelineEntries,
	type CalendarEvent,
	describeSchedule,
	eventDayKey,
	groupEventsByJob,
} from "@/src/lib/calendar/events.ts";

type JobStatus = "disabled" | "failure" | "none" | "scheduled" | "success";

const JOB_STATUS_META: Record<
	JobStatus,
	{ className: string; dotClassName: string; label: string }
> = {
	disabled: {
		className: "text-muted-foreground",
		dotClassName: "bg-muted-foreground/50",
		label: "Disabled",
	},
	failure: {
		className: "text-destructive",
		dotClassName: "bg-destructive",
		label: "Failed",
	},
	none: {
		className: "text-muted-foreground",
		dotClassName: "bg-muted-foreground/45",
		label: "No runs",
	},
	scheduled: {
		className: "text-warning",
		dotClassName: "bg-warning",
		label: "Scheduled",
	},
	success: {
		className: "text-success",
		dotClassName: "bg-success",
		label: "Operational",
	},
};

function statusForEvents(events: CalendarEvent[], enabled = true): JobStatus {
	if (!enabled) {
		return "disabled";
	}

	let latestCompleted: CalendarEvent | null = null;
	for (const event of events) {
		if (
			event.kind === "past" &&
			(!latestCompleted || event.start > latestCompleted.start)
		) {
			latestCompleted = event;
		}
	}
	if (latestCompleted) {
		return latestCompleted.outcome === "failure" ? "failure" : "success";
	}
	return events.length > 0 ? "scheduled" : "none";
}

function StatusPill({ status }: { status: JobStatus }) {
	const meta = JOB_STATUS_META[status];
	return (
		<span
			className={cn("inline-flex items-center gap-1.5 text-xs", meta.className)}
		>
			<span
				aria-hidden="true"
				className={cn("size-1.5 rounded-full", meta.dotClassName)}
			/>
			{meta.label}
		</span>
	);
}

function runCount(events: CalendarEvent[]): number {
	return events.reduce(
		(total, event) => total + (event.aggregateCount ?? 1),
		0
	);
}

function JobStatusRow({
	day,
	events,
	job,
	showScale,
}: {
	day: Date;
	events: CalendarEvent[];
	job: ScheduledJob;
	showScale: boolean;
}) {
	const dayStart = startOfDay(day);
	const dayEnd = addDays(dayStart, 1);
	const status = statusForEvents(events, job.enabled);
	const count = runCount(events);

	return (
		<div className="flex flex-col gap-2 px-3 py-3" role="listitem">
			<div className="flex items-center gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
						<span className="truncate font-medium text-sm">{job.name}</span>
						<StatusPill status={status} />
					</div>
					<p className="truncate text-muted-foreground text-xs">
						{describeSchedule(job.schedule)}
						{job.enabled ? "" : " · Paused"}
					</p>
				</div>
				<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
					{count} {count === 1 ? "run" : "runs"}
				</span>
			</div>
			<RunStatusTimeline
				ariaLabel={`${job.name} run status for ${format(day, "MMMM d, yyyy")}`}
				endAt={dayEnd.getTime()}
				entries={buildRunStatusTimelineEntries(dayStart, dayEnd, events)}
				nowAt={isToday(day) ? Date.now() : undefined}
				showScale={showScale}
				startAt={dayStart.getTime()}
			/>
		</div>
	);
}

function StatusPageOverview({
	day,
	events,
	jobs,
}: {
	day: Date;
	events: CalendarEvent[];
	jobs: ScheduledJob[];
}) {
	const dayStart = startOfDay(day);
	const dayEnd = addDays(dayStart, 1);
	const eventsByJob = groupEventsByJob(events);
	const status = statusForEvents(events);

	return (
		<section className="flex flex-col gap-3 border-b pb-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
						<h3 className="font-medium text-sm">All scheduled jobs</h3>
						<StatusPill status={status} />
					</div>
					<p className="text-muted-foreground text-xs">
						{jobs.length} {jobs.length === 1 ? "job" : "jobs"} ·{" "}
						{runCount(events)} {runCount(events) === 1 ? "run" : "runs"} in this
						24-hour window
					</p>
				</div>
				<RunStatusTimelineLegend />
			</div>
			<RunStatusTimeline
				ariaLabel={`All scheduled job status for ${format(day, "MMMM d, yyyy")}`}
				endAt={dayEnd.getTime()}
				entries={buildRunStatusTimelineEntries(dayStart, dayEnd, events)}
				nowAt={isToday(day) ? Date.now() : undefined}
				showScale
				startAt={dayStart.getTime()}
			/>
			<div className="flex items-baseline justify-between gap-3 border-t pt-3">
				<h3 className="font-medium text-sm">Jobs</h3>
				<span className="text-muted-foreground text-xs tabular-nums">
					{jobs.length} tracked
				</span>
			</div>
			<div className="divide-y rounded-lg border" role="list">
				{jobs.map((job, index) => (
					<JobStatusRow
						day={day}
						events={eventsByJob.get(job.id) ?? []}
						job={job}
						key={job.id}
						showScale={index === 0}
					/>
				))}
			</div>
		</section>
	);
}

function DayRunTimeline({
	day,
	events,
	showScale,
}: {
	day: Date;
	events: CalendarEvent[];
	showScale: boolean;
}) {
	const dayStart = startOfDay(day);
	const dayEnd = addDays(dayStart, 1);
	const runCount = events.reduce(
		(total, event) => total + (event.aggregateCount ?? 1),
		0
	);

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between gap-3">
				<span className="font-medium text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
					24h run status
				</span>
				<span className="text-[10px] text-muted-foreground tabular-nums">
					{runCount} {runCount === 1 ? "run" : "runs"}
				</span>
			</div>
			<RunStatusTimeline
				ariaLabel={`Run status for ${format(day, "MMMM d, yyyy")}`}
				endAt={dayEnd.getTime()}
				entries={buildRunStatusTimelineEntries(dayStart, dayEnd, events)}
				nowAt={isToday(day) ? Date.now() : undefined}
				showScale={showScale}
				startAt={dayStart.getTime()}
			/>
		</div>
	);
}

export function AgendaView({
	days,
	eventsByDay,
	jobs,
}: {
	days: Date[];
	eventsByDay: Map<string, CalendarEvent[]>;
	jobs: ScheduledJob[];
}) {
	const populated = days
		.map((day) => ({ day, events: eventsByDay.get(eventDayKey(day)) ?? [] }))
		.filter((entry) => entry.events.length > 0);
	const overviewDay =
		days.find((day) => isToday(day)) ?? populated[0]?.day ?? days[0];

	if (!overviewDay || (populated.length === 0 && jobs.length === 0)) {
		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
				<HugeiconsIcon
					className="size-6 opacity-50"
					icon={CalendarCheckIn01Icon}
				/>
				<p className="text-sm">No runs in this period</p>
			</div>
		);
	}

	return (
		<div className="scroll-fade min-h-0 flex-1 overflow-auto">
			<div className="mx-auto flex max-w-2xl flex-col gap-5 p-4">
				<StatusPageOverview
					day={overviewDay}
					events={eventsByDay.get(eventDayKey(overviewDay)) ?? []}
					jobs={jobs}
				/>
				{populated.map(({ day, events }) => (
					<section className="flex flex-col gap-2" key={eventDayKey(day)}>
						<div className="flex items-baseline gap-2 border-b pb-1.5">
							<span
								className={cn(
									"font-semibold text-sm",
									isToday(day) ? "text-primary" : "text-foreground"
								)}
							>
								{format(day, "EEEE")}
							</span>
							<span className="text-muted-foreground text-xs">
								{format(day, "MMMM d, yyyy")}
							</span>
							{isToday(day) && (
								<span className="ml-auto font-medium text-primary text-xs">
									Today
								</span>
							)}
						</div>
						{eventDayKey(day) === eventDayKey(overviewDay) ? null : (
							<DayRunTimeline day={day} events={events} showScale={false} />
						)}
						<div className="flex flex-col gap-2">
							{events.map((event) => (
								<EventRow event={event} key={event.id} />
							))}
						</div>
					</section>
				))}
			</div>
		</div>
	);
}
