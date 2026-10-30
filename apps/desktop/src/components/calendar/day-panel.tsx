import {
	ArrowLeft01Icon,
	CalendarCheckIn01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { QuietEmpty } from "@/src/components/agents/shared/quiet-empty.tsx";
import { EventRow } from "@/src/components/calendar/event-display.tsx";
import { useCalendarLocale } from "@/src/components/calendar/use-calendar-locale.ts";
import { formatCalendarDate } from "@/src/lib/calendar/date-labels.ts";
import type { CalendarEvent } from "@/src/lib/calendar/events.ts";

export function DayPanel({
	day,
	events,
	onClose,
}: {
	day: Date;
	events: CalendarEvent[];
	onClose: () => void;
}) {
	const locale = useCalendarLocale();
	return (
		<aside className="flex w-72 shrink-0 flex-col border-l">
			<div className="flex h-10 shrink-0 items-center justify-between gap-2 border-border border-b pr-1 pl-3">
				<p className="min-w-0 truncate text-sm">
					<span className="font-medium">
						{formatCalendarDate(day, "weekday", locale)}
					</span>{" "}
					<span className="text-muted-foreground">
						{formatCalendarDate(day, "longDate", locale)}
					</span>
				</p>
				<Button
					aria-label="Close day details"
					onClick={onClose}
					size="icon-sm"
					variant="ghost-muted"
				>
					<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
				</Button>
			</div>
			<div className="scroll-fade flex-1 overflow-auto px-3 py-1">
				{events.length === 0 ? (
					<QuietEmpty icon={CalendarCheckIn01Icon} title="No runs scheduled" />
				) : (
					<div className="flex flex-col">
						{events.map((event) => (
							<EventRow event={event} key={event.id} />
						))}
					</div>
				)}
			</div>
		</aside>
	);
}
