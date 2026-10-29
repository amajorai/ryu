import type { CSSProperties } from "react";
import "./TimeGridView.css";
// apps/desktop/src/components/calendar/TimeGridView.tsx
//
// Time-grid view shared by the Week (7 columns) and Day (1 column) calendar
// modes, modelled on origin-space/event-calendar. Hours run down the left
// gutter; each day is a column in which events are absolutely positioned by
// their start time. Scheduled runs are point-in-time (no end), so each is drawn
// as a fixed-height block and overlapping blocks are split into side-by-side
// lanes so none is hidden.

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { format } from "date-fns";
import { useEffect, useMemo, useRef } from "react";
import {
	eventTime,
	eventTone,
} from "@/src/components/calendar/event-display.tsx";
import { useCalendarLocale } from "@/src/components/calendar/use-calendar-locale.ts";
import { formatCalendarDate } from "@/src/lib/calendar/date-labels.ts";
import {
	civilDayKey,
	isDisplayToday,
	minutesIntoDisplayDay,
} from "@/src/lib/calendar/display-days.ts";
import type { CalendarEvent } from "@/src/lib/calendar/events.ts";

const HOUR_HEIGHT = 48; // px per hour row
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const BLOCK_MINUTES = 30; // visual duration given to each point-in-time run
const SCROLL_TO_HOUR = 7; // initial scroll position (business hours)

interface PlacedEvent {
	event: CalendarEvent;
	lane: number;
	lanes: number;
}

/** Pack a day's events into the fewest side-by-side lanes without overlap. */
function packLanes(events: CalendarEvent[]): PlacedEvent[] {
	const sorted = [...events].sort(
		(a, b) => a.start.getTime() - b.start.getTime()
	);
	const laneEnds: number[] = [];
	const placed = sorted.map((event) => {
		const startMs = event.start.getTime();
		const endMs = startMs + BLOCK_MINUTES * 60_000;
		let lane = laneEnds.findIndex((end) => end <= startMs);
		if (lane === -1) {
			lane = laneEnds.length;
			laneEnds.push(endMs);
		} else {
			laneEnds[lane] = endMs;
		}
		return { event, lane };
	});
	const lanes = laneEnds.length || 1;
	return placed.map((p) => ({ ...p, lanes }));
}

function TimeGridEvent({
	placed,
	onSelect,
}: {
	placed: PlacedEvent;
	onSelect: (event: CalendarEvent) => void;
}) {
	const { event, lane, lanes } = placed;
	const top = (minutesIntoDisplayDay(event.start) / 60) * HOUR_HEIGHT;
	const height = (BLOCK_MINUTES / 60) * HOUR_HEIGHT;
	const widthPct = 100 / lanes;
	const calendarEventVariables1: CSSProperties & {
		"--calendar-event-top": string;
		"--calendar-event-height": string;
		"--calendar-event-left": string;
		"--calendar-event-width": string;
	} = {
		"--calendar-event-top": `${top}px`,
		"--calendar-event-height": `${Math.max(height, 18)}px`,
		"--calendar-event-left": `${lane * widthPct}%`,
		"--calendar-event-width": `calc(${widthPct}% - 2px)`,
	};
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						className={cn(
							"type-caption absolute overflow-hidden rounded-sm border-l-2 px-1 py-0.5 text-left leading-tight transition-colors hover:brightness-110",
							eventTone(event)
						)}
						data-calendar-event=""
						onClick={(e) => {
							e.stopPropagation();
							onSelect(event);
						}}
						style={calendarEventVariables1}
						type="button"
					>
						<span className="flex items-center gap-1 truncate">
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
						</span>
					</button>
				}
			/>
			<TooltipContent>{`${event.jobName} — ${event.scheduleLabel}`}</TooltipContent>
		</Tooltip>
	);
}

/** Red "now" indicator line, shown only inside today's column. */
function NowIndicator() {
	const top = (minutesIntoDisplayDay(Date.now()) / 60) * HOUR_HEIGHT;
	const calendarPositionVariables2: CSSProperties & {
		"--calendar-event-top": string;
	} = { "--calendar-event-top": `${top}px` };
	return (
		<div
			className="pointer-events-none absolute right-0 left-0 z-10 flex items-center"
			data-calendar-now=""
			style={calendarPositionVariables2}
		>
			<span className="-ml-1 size-2 rounded-full bg-destructive" />
			<span className="h-px flex-1 bg-destructive" />
		</div>
	);
}

export function TimeGridView({
	days,
	eventsByDay,
	onSelectEvent,
}: {
	days: Date[];
	eventsByDay: Map<string, CalendarEvent[]>;
	onSelectEvent: (event: CalendarEvent) => void;
}) {
	const locale = useCalendarLocale();
	const scrollRef = useRef<HTMLDivElement>(null);
	const placedByDay = useMemo(
		() => days.map((day) => packLanes(eventsByDay.get(civilDayKey(day)) ?? [])),
		[days, eventsByDay]
	);

	// Scroll to business hours on mount and whenever the day range changes.
	// `rangeKey` is load-bearing — it is the whole "whenever the day range
	// changes" half. It is a joined string rather than `days` because `days` is a
	// fresh array each render, which would re-scroll on every render.
	const rangeKey = days.map((d) => civilDayKey(d)).join("|");
	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = SCROLL_TO_HOUR * HOUR_HEIGHT;
		}
	}, [rangeKey]);

	const calendarGridVariables: CSSProperties & {
		"--calendar-hour-height": string;
	} = { "--calendar-hour-height": `${HOUR_HEIGHT}px` };
	return (
		<div className="flex min-h-0 flex-1 flex-col" style={calendarGridVariables}>
			{/* Column headers (one per day) */}
			<div className="flex shrink-0 border-b" data-calendar-heading="">
				<div className="w-14 shrink-0 border-r" />
				{days.map((day) => {
					const today = isDisplayToday(day);
					return (
						<div
							className="flex-1 border-r py-1.5 text-center last:border-r-0"
							key={civilDayKey(day)}
						>
							<div className="font-medium text-muted-foreground text-xs">
								{formatCalendarDate(day, "weekdayShort", locale)}
							</div>
							<div
								className={cn(
									"mx-auto flex size-6 items-center justify-center rounded-full text-sm",
									today
										? "bg-primary font-medium text-primary-foreground"
										: "text-foreground"
								)}
							>
								{formatCalendarDate(day, "dayOfMonth", locale)}
							</div>
						</div>
					);
				})}
			</div>

			{/* Scrollable hour grid */}
			<div className="scroll-fade min-h-0 flex-1 overflow-auto" ref={scrollRef}>
				<div className="flex">
					{/* Hour gutter */}
					<div className="w-14 shrink-0">
						{HOURS.map((hour) => (
							<div
								className="relative border-r"
								data-calendar-hour=""
								key={hour}
							>
								<span className="type-compact absolute -top-2 right-1.5 text-muted-foreground tabular-nums">
									{hour === 0
										? ""
										: format(new Date(2000, 0, 1, hour), "HH:mm")}
								</span>
							</div>
						))}
					</div>

					{/* Day columns */}
					{days.map((day, dayIndex) => (
						<div
							className="relative flex-1 border-r last:border-r-0"
							key={civilDayKey(day)}
						>
							{HOURS.map((hour) => (
								<div className="border-b" data-calendar-hour="" key={hour} />
							))}
							{isDisplayToday(day) && <NowIndicator />}
							{placedByDay[dayIndex].map((placed) => (
								<TimeGridEvent
									key={placed.event.id}
									onSelect={onSelectEvent}
									placed={placed}
								/>
							))}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
