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
import {
	buildRunStatusTimelineEntries,
	type CalendarEvent,
	eventDayKey,
} from "@/src/lib/calendar/events.ts";

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
}: {
	days: Date[];
	eventsByDay: Map<string, CalendarEvent[]>;
}) {
	const populated = days
		.map((day) => ({ day, events: eventsByDay.get(eventDayKey(day)) ?? [] }))
		.filter((entry) => entry.events.length > 0);

	if (populated.length === 0) {
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
				<div className="flex flex-wrap items-center justify-between gap-3 border-b pb-2">
					<div>
						<p className="font-medium text-sm">Run status</p>
						<p className="text-muted-foreground text-xs">
							Each strip spans midnight to midnight; hover a bar for its run.
						</p>
					</div>
					<RunStatusTimelineLegend />
				</div>
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
						<DayRunTimeline
							day={day}
							events={events}
							showScale={
								eventDayKey(day) === eventDayKey(populated[0]?.day ?? day)
							}
						/>
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
