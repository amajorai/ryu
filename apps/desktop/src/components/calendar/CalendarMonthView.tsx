// apps/desktop/src/components/calendar/CalendarMonthView.tsx
//
// Month grid and selected-day panel for the Calendar page. Weekday and date
// labels come from Intl in the active i18n locale.

import {
	ArrowLeft01Icon,
	CalendarCheckIn01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { isSameDay, isSameMonth } from "date-fns";
import { useMemo } from "react";
import {
	EventRow,
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

const MAX_PILLS_PER_CELL = 3;

function EventPill({
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
							"type-caption pointer-events-auto flex w-full items-center gap-1 truncate rounded-sm border-l-2 px-1 py-0.5 text-left leading-tight transition-colors hover:brightness-110",
							eventTone(event)
						)}
						onClick={() => onSelect(event)}
						type="button"
					>
						<span className="shrink-0 font-medium tabular-nums opacity-70">
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

function DayCell({
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
				"relative flex min-h-[104px] flex-col gap-1 border-r border-b p-1.5 text-left transition-colors hover:bg-muted/40",
				inMonth ? "bg-background" : "bg-muted/20",
				selected && "ring-1 ring-primary ring-inset"
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
						!(today || inMonth) && "text-muted-foreground/50",
						!today && inMonth && "text-foreground"
					)}
				>
					{formatCalendarDate(day, "dayOfMonth", locale)}
				</span>
				{events.length > 0 && (
					<span className="type-compact text-muted-foreground tabular-nums">
						{events.length}
					</span>
				)}
			</div>
			<div className="pointer-events-none relative flex flex-col gap-0.5">
				{events.slice(0, MAX_PILLS_PER_CELL).map((event) => (
					<EventPill event={event} key={event.id} onSelect={onSelectEvent} />
				))}
				{overflow > 0 && (
					<span className="type-compact px-1 text-muted-foreground">
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
			<div className="grid shrink-0 grid-cols-7 border-b">
				{labels.map((label) => (
					<div
						className="border-r py-1.5 text-center font-medium text-muted-foreground text-xs last:border-r-0"
						key={label}
					>
						{label}
					</div>
				))}
			</div>
			<div className="grid flex-1 auto-rows-fr grid-cols-7 overflow-auto border-l">
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
			<div className="flex shrink-0 items-center justify-between border-b px-3 py-2.5">
				<div>
					<p className="font-medium text-sm">
						{formatCalendarDate(day, "weekday", locale)}
					</p>
					<p className="text-muted-foreground text-xs">
						{formatCalendarDate(day, "longDate", locale)}
					</p>
				</div>
				<Button
					aria-label="Close day details"
					onClick={onClose}
					size="icon"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
				</Button>
			</div>
			<div className="scroll-fade flex-1 overflow-auto p-3">
				{events.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
						<HugeiconsIcon
							className="size-6 opacity-50"
							icon={CalendarCheckIn01Icon}
						/>
						<p className="text-sm">No runs scheduled</p>
					</div>
				) : (
					<div className="flex flex-col gap-2">
						{events.map((event) => (
							<EventRow event={event} key={event.id} />
						))}
					</div>
				)}
			</div>
		</aside>
	);
}
