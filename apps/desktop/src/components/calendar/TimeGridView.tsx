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
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import { format, isToday } from "date-fns";
import { useEffect, useMemo, useRef } from "react";
import { eventTone } from "@/src/components/calendar/event-display.tsx";
import { type CalendarEvent, eventDayKey } from "@/src/lib/calendar/events.ts";

const HOUR_HEIGHT = 48; // px per hour row
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const BLOCK_MINUTES = 30; // visual duration given to each point-in-time run
const SCROLL_TO_HOUR = 7; // initial scroll position (business hours)

function minutesIntoDay(date: Date): number {
	return date.getHours() * 60 + date.getMinutes();
}

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
	const top = (minutesIntoDay(event.start) / 60) * HOUR_HEIGHT;
	const height = (BLOCK_MINUTES / 60) * HOUR_HEIGHT;
	const widthPct = 100 / lanes;
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						className={cn(
							"absolute overflow-hidden rounded-sm border-l-2 px-1 py-0.5 text-left text-[11px] leading-tight transition-colors hover:brightness-110",
							eventTone(event)
						)}
						onClick={(e) => {
							e.stopPropagation();
							onSelect(event);
						}}
						style={{
							top: `${top}px`,
							height: `${Math.max(height, 18)}px`,
							left: `${lane * widthPct}%`,
							width: `calc(${widthPct}% - 2px)`,
						}}
						type="button"
					>
						<span className="flex items-center gap-1 truncate">
							<span className="shrink-0 font-medium tabular-nums opacity-70">
								{event.aggregateCount
									? `${event.aggregateCount}×`
									: format(event.start, "HH:mm")}
							</span>
							<span className="truncate">{event.jobName}</span>
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
	const top = (minutesIntoDay(new Date()) / 60) * HOUR_HEIGHT;
	return (
		<div
			className="pointer-events-none absolute right-0 left-0 z-10 flex items-center"
			style={{ top: `${top}px` }}
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
	const scrollRef = useRef<HTMLDivElement>(null);
	const placedByDay = useMemo(
		() => days.map((day) => packLanes(eventsByDay.get(eventDayKey(day)) ?? [])),
		[days, eventsByDay]
	);

	// Scroll to business hours on mount and whenever the day range changes.
	const _rangeKey = days.map((d) => eventDayKey(d)).join("|");
	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = SCROLL_TO_HOUR * HOUR_HEIGHT;
		}
	}, []);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* Column headers (one per day) */}
			<div className="flex shrink-0 border-b pr-[var(--scrollbar,0)]">
				<div className="w-14 shrink-0 border-r" />
				{days.map((day) => {
					const today = isToday(day);
					return (
						<div
							className="flex-1 border-r py-1.5 text-center last:border-r-0"
							key={eventDayKey(day)}
						>
							<div className="font-medium text-muted-foreground text-xs">
								{format(day, "EEE")}
							</div>
							<div
								className={cn(
									"mx-auto flex size-6 items-center justify-center rounded-full text-sm",
									today
										? "bg-primary font-semibold text-primary-foreground"
										: "text-foreground"
								)}
							>
								{format(day, "d")}
							</div>
						</div>
					);
				})}
			</div>

			{/* Scrollable hour grid */}
			<div
				className="scroll-fade-effect-y min-h-0 flex-1 overflow-auto"
				ref={scrollRef}
			>
				<div className="flex">
					{/* Hour gutter */}
					<div className="w-14 shrink-0">
						{HOURS.map((hour) => (
							<div
								className="relative border-r"
								key={hour}
								style={{ height: `${HOUR_HEIGHT}px` }}
							>
								<span className="absolute -top-2 right-1.5 text-[10px] text-muted-foreground tabular-nums">
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
							key={eventDayKey(day)}
						>
							{HOURS.map((hour) => (
								<div
									className="border-b"
									key={hour}
									style={{ height: `${HOUR_HEIGHT}px` }}
								/>
							))}
							{isToday(day) && <NowIndicator />}
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
