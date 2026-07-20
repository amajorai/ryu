// apps/desktop/src/components/calendar/AgendaView.tsx
//
// Agenda view for the Calendar page: a chronological list of scheduled runs
// grouped by day, skipping days with nothing on them. Modelled on the agenda
// mode of origin-space/event-calendar.

import { CalendarCheckIn01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils";
import { format, isToday } from "date-fns";
import { EventRow } from "@/src/components/calendar/event-display.tsx";
import { type CalendarEvent, eventDayKey } from "@/src/lib/calendar/events.ts";

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
		<div className="scroll-fade-effect-y min-h-0 flex-1 overflow-auto">
			<div className="mx-auto flex max-w-2xl flex-col gap-5 p-4">
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
