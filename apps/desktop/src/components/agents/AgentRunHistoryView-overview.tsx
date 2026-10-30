import { useLiteralMessages } from "@ryu/i18n/react";
import {
	RunStatusTimeline,
	RunStatusTimelineLegend,
} from "@ryu/ui/components/run-status-timeline.tsx";
import { formatDateTime } from "@ryu/ui/lib/timezone.ts";
import { formatDistanceToNow } from "date-fns";
import type { ScheduledJob } from "@/src/lib/api/schedules.ts";
import {
	buildCalendarEvents,
	buildRunStatusTimelineEntries,
	describeSchedule,
	groupEventsByJob,
} from "@/src/lib/calendar/events.ts";

export function AgentRunOverview({ jobs }: { jobs: ScheduledJob[] }) {
	const tl = useLiteralMessages();
	const now = new Date();
	const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	const events = buildCalendarEvents(jobs, start, now);
	const eventsByJob = groupEventsByJob(events);
	const failed = events.filter(
		(event) => event.kind === "past" && event.outcome === "failure"
	).length;
	const completed = events.filter(
		(event) => event.kind === "past" && event.outcome === "success"
	).length;

	return (
		<section className="flex flex-col gap-3" data-testid="agent-run-overview">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h3 className="font-medium text-sm">Run status · last 24 hours</h3>
					<p className="mt-0.5 text-detail text-muted-foreground tabular-nums">
						{tl(
							"{completed} completed · {failed} failed · {count, plural, one {# routine} other {# routines}}",
							{
								completed: String(completed),
								count: jobs.length,
								failed: String(failed),
							}
						)}
					</p>
				</div>
				<RunStatusTimelineLegend />
			</div>
			<RunStatusTimeline
				ariaLabel={tl(
					"All {count} agent routine statuses for the last 24 hours",
					{ count: String(jobs.length) }
				)}
				endAt={now.getTime()}
				entries={buildRunStatusTimelineEntries(start, now, events)}
				nowAt={now.getTime()}
				showScale
				startAt={start.getTime()}
			/>
			<div className="grid gap-2 border-t pt-3 sm:grid-cols-2">
				{jobs.map((job) => {
					const jobEvents = eventsByJob.get(job.id) ?? [];
					const last = [...job.history].sort(
						(a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)
					)[0];
					return (
						<div className="min-w-0" key={job.id}>
							<div className="flex items-center justify-between gap-2 text-xs">
								<span className="truncate font-medium" title={job.name}>
									{job.name}
								</span>
								<span className="shrink-0 text-muted-foreground">
									{job.enabled ? describeSchedule(job.schedule) : "Paused"}
								</span>
							</div>
							<RunStatusTimeline
								ariaLabel={tl("{name} status for the last 24 hours", {
									name: job.name,
								})}
								className="mt-1"
								endAt={now.getTime()}
								entries={buildRunStatusTimelineEntries(start, now, jobEvents)}
								startAt={start.getTime()}
							/>
							<p className="mt-1 truncate text-muted-foreground text-xs">
								{last
									? `${last.outcome === "success" ? "Succeeded" : "Failed"} ${formatDistanceToNow(new Date(last.startedAt), { addSuffix: true })}`
									: "No runs yet"}
							</p>
						</div>
					);
				})}
			</div>
			<p className="text-muted-foreground/70 text-xs">
				{tl(
					"Window ending {time}. Open an automated run below to inspect its full persistent transcript.",
					{
						time: formatDateTime(now, {
							month: "short",
							day: "numeric",
							hour: "2-digit",
							minute: "2-digit",
							hourCycle: "h23",
						}),
					}
				)}
			</p>
		</section>
	);
}
