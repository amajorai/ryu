import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { isSameDay, isSameMonth } from "date-fns";
import { useMemo } from "react";
import {
	eventTime,
	eventTone,
} from "@/src/components/calendar/event-display.tsx";
import { useCalendarLocale } from "@/src/components/calendar/use-calendar-locale.ts";
import {
	formatCalendarDate,
	weekdayLabels,
} from "@/src/lib/calendar/date-labels.ts";
import {
	civilDayKey,
	isDisplayToday,
} from "@/src/lib/calendar/display-days.ts";
import type { CalendarEvent } from "@/src/lib/calendar/events.ts";

export const MAX_PILLS_PER_CELL = 3;

export function EventPill({
	event,
	onSelect,
}: {
	event: CalendarEvent;
	onSelect: (event: CalendarEvent) => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						className={cn(
							"pointer-events-auto flex w-full items-center gap-1 truncate rounded-lg px-1.5 py-0.5 text-left text-xs transition-colors hover:brightness-95 dark:hover:brightness-125",
							eventTone(event)
						)}
						onClick={() => onSelect(event)}
						type="button"
					>
						<span className="shrink-0 text-muted-foreground tabular-nums">
							{eventTime(event)}
						</span>
						<span
							className="truncate"
							data-ryu-i18n="off"
							title={event.jobName}
						>
							{event.jobName}
						</span>
					</button>
				}
			/>
			<TooltipContent>{`${event.jobName} — ${event.scheduleLabel}`}</TooltipContent>
		</Tooltip>
	);
}

export function DayCell({
	day,
	monthCursor,
	events,
	selected,
	onSelectDay,
	onSelectEvent,
}: {
	day: Date;
	monthCursor: Date;
	events: CalendarEvent[];
	selected: boolean;
	onSelectDay: (day: Date) => void;
	onSelectEvent: (event: CalendarEvent) => void;
}) {
	const locale = useCalendarLocale();
	const tl = useLiteralMessages();
	const inMonth = isSameMonth(day, monthCursor);
	const today = isDisplayToday(day);
	const overflow = events.length - MAX_PILLS_PER_CELL;

	// The day button covers the whole cell and the run pills sit above it, so a
	// click anywhere but on a pill opens the day, with no button inside a button.
	return (
		<div
			className={cn(
				"relative flex min-h-[104px] flex-col gap-1 border-border border-r border-b p-1.5 text-left transition-colors duration-150 hover:bg-muted/40 hover:duration-0",
				selected && "bg-accent"
			)}
		>
			<button
				aria-label={formatCalendarDate(day, "fullDate", locale)}
				className="absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
				onClick={() => onSelectDay(day)}
				type="button"
			/>
			<div className="flex items-center justify-between">
				<span
					className={cn(
						"flex size-6 items-center justify-center rounded-full text-xs",
						today && "bg-primary font-medium text-primary-foreground",
						!(today || inMonth) && "text-muted-foreground/70",
						!today && inMonth && "text-foreground"
					)}
				>
					{formatCalendarDate(day, "dayOfMonth", locale)}
				</span>
				{overflow > 0 && (
					<span className="text-muted-foreground/70 text-xs tabular-nums">
						{events.length}
					</span>
				)}
			</div>
			<div className="pointer-events-none relative flex flex-col gap-0.5">
				{events.slice(0, MAX_PILLS_PER_CELL).map((event) => (
					<EventPill event={event} key={event.id} onSelect={onSelectEvent} />
				))}
				{overflow > 0 && (
					<span className="px-1.5 text-muted-foreground text-xs">
						{tl("+{overflow} more", { overflow })}
					</span>
				)}
			</div>
		</div>
	);
}

export function MonthView({
	cursor,
	days,
	eventsByDay,
	selectedDay,
	onSelectDay,
	onSelectEvent,
}: {
	cursor: Date;
	days: Date[];
	eventsByDay: Map<string, CalendarEvent[]>;
	selectedDay: Date | null;
	onSelectDay: (day: Date) => void;
	onSelectEvent: (event: CalendarEvent) => void;
}) {
	const locale = useCalendarLocale();
	const labels = useMemo(() => weekdayLabels(locale), [locale]);
	return (
		<div className="flex min-w-0 flex-1 flex-col">
			<div className="grid shrink-0 grid-cols-7 border-border border-b">
				{labels.map((label) => (
					<div
						className="py-1.5 text-center text-muted-foreground text-xs"
						key={label}
					>
						{label}
					</div>
				))}
			</div>
			<div className="grid flex-1 auto-rows-fr grid-cols-7 overflow-auto">
				{days.map((day) => (
					<DayCell
						day={day}
						events={eventsByDay.get(civilDayKey(day)) ?? []}
						key={day.toISOString()}
						monthCursor={cursor}
						onSelectDay={onSelectDay}
						onSelectEvent={onSelectEvent}
						selected={!!selectedDay && isSameDay(day, selectedDay)}
					/>
				))}
			</div>
		</div>
	);
}
