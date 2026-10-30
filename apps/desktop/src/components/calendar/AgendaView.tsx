// apps/desktop/src/components/calendar/AgendaView.tsx
//
// Agenda view for the Calendar page: a chronological list of scheduled runs
// grouped by day, skipping days with nothing on them. Modelled on the agenda
// mode of origin-space/event-calendar.

import { CalendarCheckIn01Icon } from "@hugeicons/core-free-icons";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	RunStatusTimeline,
	RunStatusTimelineLegend,
} from "@ryu/ui/components/run-status-timeline.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { QuietEmpty } from "@/src/components/agents/shared/quiet-empty.tsx";
import { EventRow } from "@/src/components/calendar/event-display.tsx";
import { useCalendarLocale } from "@/src/components/calendar/use-calendar-locale.ts";
import type { ScheduledJob } from "@/src/lib/api/schedules.ts";
import { formatCalendarDate } from "@/src/lib/calendar/date-labels.ts";
import {
	civilDayKey,
	displayDayBounds,
	isDisplayToday,
} from "@/src/lib/calendar/display-days.ts";
import {
	buildRunStatusTimelineEntries,
	type CalendarEvent,
	describeSchedule,
	groupEventsByJob,
} from "@/src/lib/calendar/events.ts";

type JobStatus = "disabled" | "failure" | "none" | "scheduled" | "success";

const JOB_STATUS_META = {
	disabled: {
		className: "text-muted-foreground",
		dotClassName: "bg-muted-foreground/50",
		label: "Disabled",
	},
	failure: {
		className: "text-status-destructive",
		dotClassName: "bg-destructive",
		label: "Failed",
	},
	none: {
		className: "text-muted-foreground",
		dotClassName: "bg-muted-foreground/45",
		label: "No runs",
	},
	scheduled: {
		className: "text-status-warning",
		dotClassName: "bg-warning",
		label: "Scheduled",
	},
	success: {
		className: "text-status-success",
		dotClassName: "bg-success",
		label: "Operational",
	},
} satisfies Record<
	JobStatus,
	{ className: string; dotClassName: string; label: string }
>;

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
	const locale = useCalendarLocale();
	const tl = useLiteralMessages();
	const { start: dayStart, end: dayEnd } = displayDayBounds(day);
	const status = statusForEvents(events, job.enabled);
	const count = runCount(events);

	return (
		<div className="flex flex-col gap-2 py-3" role="listitem">
			<div className="flex items-center gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
						<span
							className="truncate font-medium text-sm"
							data-ryu-i18n="off"
							title={job.name}
						>
							{job.name}
						</span>
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
				ariaLabel={tl("{name} run status for {date}", {
					date: formatCalendarDate(day, "longDate", locale),
					name: job.name,
				})}
				endAt={dayEnd.getTime()}
				entries={buildRunStatusTimelineEntries(dayStart, dayEnd, events)}
				nowAt={isDisplayToday(day) ? Date.now() : undefined}
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
	const locale = useCalendarLocale();
	const tl = useLiteralMessages();
	const { start: dayStart, end: dayEnd } = displayDayBounds(day);
	const totalRuns = runCount(events);
	const eventsByJob = groupEventsByJob(events);
	const status = statusForEvents(events);

	return (
		<section className="flex flex-col gap-3 border-b pb-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
						<h3 className="font-semibold text-sm">All scheduled jobs</h3>
						<StatusPill status={status} />
					</div>
					<p className="text-muted-foreground text-xs">
						{tl(
							"{jobCount, plural, one {{jobCountLabel} job} other {{jobCountLabel} jobs}} · {runCount, plural, one {{runCountLabel} run} other {{runCountLabel} runs}} in this 24-hour window",
							{
								jobCount: jobs.length,
								jobCountLabel: String(jobs.length),
								runCount: totalRuns,
								runCountLabel: String(totalRuns),
							}
						)}
					</p>
				</div>
				<RunStatusTimelineLegend />
			</div>
			<RunStatusTimeline
				ariaLabel={tl("All scheduled job status for {date}", {
					date: formatCalendarDate(day, "longDate", locale),
				})}
				endAt={dayEnd.getTime()}
				entries={buildRunStatusTimelineEntries(dayStart, dayEnd, events)}
				nowAt={isDisplayToday(day) ? Date.now() : undefined}
				showScale
				startAt={dayStart.getTime()}
			/>
			<div className="flex items-baseline justify-between gap-3 border-t pt-3">
				<h3 className="font-semibold text-sm">Jobs</h3>
				<span className="text-muted-foreground text-xs tabular-nums">
					{tl("{jobCount} tracked", { jobCount: jobs.length })}
				</span>
			</div>
			<div className="divide-y divide-border" role="list">
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
	const locale = useCalendarLocale();
	const tl = useLiteralMessages();
	const { start: dayStart, end: dayEnd } = displayDayBounds(day);
	const runCount = events.reduce(
		(total, event) => total + (event.aggregateCount ?? 1),
		0
	);

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between gap-3">
				<span className="text-detail text-muted-foreground">
					24h run status
				</span>
				<span className="text-muted-foreground/70 text-xs tabular-nums">
					{runCount} {runCount === 1 ? "run" : "runs"}
				</span>
			</div>
			<RunStatusTimeline
				ariaLabel={tl("Run status for {date}", {
					date: formatCalendarDate(day, "longDate", locale),
				})}
				endAt={dayEnd.getTime()}
				entries={buildRunStatusTimelineEntries(dayStart, dayEnd, events)}
				nowAt={isDisplayToday(day) ? Date.now() : undefined}
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
	const locale = useCalendarLocale();
	const populated = days
		.map((day) => ({ day, events: eventsByDay.get(civilDayKey(day)) ?? [] }))
		.filter((entry) => entry.events.length > 0);
	const overviewDay =
		days.find((day) => isDisplayToday(day)) ?? populated[0]?.day ?? days[0];

	if (!overviewDay || (populated.length === 0 && jobs.length === 0)) {
		return (
			<QuietEmpty
				className="min-h-0 flex-1"
				icon={CalendarCheckIn01Icon}
				title="No runs in this period"
			/>
		);
	}

	return (
		<div className="scroll-fade min-h-0 flex-1 overflow-auto">
			<div className="mx-auto flex max-w-2xl flex-col gap-6 p-4">
				<StatusPageOverview
					day={overviewDay}
					events={eventsByDay.get(civilDayKey(overviewDay)) ?? []}
					jobs={jobs}
				/>
				{populated.map(({ day, events }) => (
					<section className="flex flex-col gap-2" key={civilDayKey(day)}>
						<div className="flex items-baseline gap-2 border-b pb-1.5">
							<span
								className={cn(
									"font-medium text-sm",
									isDisplayToday(day) ? "text-primary" : "text-foreground"
								)}
							>
								{formatCalendarDate(day, "weekday", locale)}
							</span>
							<span className="text-muted-foreground text-xs">
								{formatCalendarDate(day, "longDate", locale)}
							</span>
							{isDisplayToday(day) && (
								<span className="ml-auto font-medium text-primary text-xs">
									Today
								</span>
							)}
						</div>
						{civilDayKey(day) === civilDayKey(overviewDay) ? null : (
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
