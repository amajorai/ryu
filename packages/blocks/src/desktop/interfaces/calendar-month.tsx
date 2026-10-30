import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { localDayKey } from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import {
	type CalendarItem,
	cellCapacity,
	cellDayLabel,
	cellItems,
	longDay,
	sameMonth,
	weekdayNames,
} from "./calendar-model.ts";
import {
	CalendarChip,
	type CalendarItemHandlers,
	DayAgendaPopover,
} from "./calendar-month-agenda.tsx";
import {
	CALENDAR_DAY_ATTRIBUTE,
	EYEBROW_CLASS,
	ITEM_RADIUS_CLASS,
} from "./calendar-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

// biome-ignore lint/performance/noBarrelFile: keeps the original public import path stable.
export {
	CalendarChip,
	type CalendarItemHandlers,
	DayAgendaPopover,
} from "./calendar-month-agenda.tsx";

const DEFAULT_CAPACITY = 4;
/**
 * A phone-width cell draws its items as bare dots: three of them and a
 * "+N" are all it shows, however tall it is.
 */
const NARROW_CELL_PX = 96;
const NARROW_CAPACITY = 4;

/** "+N more": the rest of a month cell, in the day's agenda popover. */
function MoreButton({
	date,
	handlers,
	hiddenCount,
	isToday,
	items,
	onOpenDay,
	tabStop,
}: {
	date: Date;
	handlers: CalendarItemHandlers;
	hiddenCount: number;
	isToday: boolean;
	items: readonly CalendarItem[];
	onOpenDay: (key: string) => void;
	tabStop: boolean;
}) {
	const tl = useLiteralMessages();
	return (
		<DayAgendaPopover
			date={date}
			handlers={handlers}
			isToday={isToday}
			items={items}
			onOpenDay={onOpenDay}
			tabStop={tabStop}
			triggerClassName={cn(
				"h-5 w-full shrink-0 truncate whitespace-nowrap px-1 text-left @max-[6rem]:text-center font-medium text-muted-foreground text-xs outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted aria-expanded:text-foreground",
				ITEM_RADIUS_CLASS
			)}
			triggerLabel={tl("{hiddenCount} more on {day}", {
				hiddenCount,
				day: longDay(date),
			})}
		>
			+{hiddenCount}
			<span className="@max-[5rem]:hidden"> more</span>
		</DayAgendaPopover>
	);
}

function MonthCell({
	capacity,
	date,
	focusKey,
	handlers,
	inMonth,
	items,
	onOpenDay,
	onSelectDay,
	todayKey,
}: {
	capacity: number;
	date: Date;
	focusKey: string;
	handlers: CalendarItemHandlers;
	inMonth: boolean;
	items: readonly CalendarItem[];
	/** Open the day's week, like a calendar's date number does. */
	onOpenDay: (key: string) => void;
	onSelectDay: (key: string) => void;
	todayKey: string;
}) {
	const tl = useLiteralMessages();
	const key = localDayKey(date);
	const isToday = key === todayKey;
	const focused = key === focusKey;
	const { hidden, shown } = cellItems(
		items,
		capacity,
		handlers.activeThreadId ? `thread:${handlers.activeThreadId}` : null
	);
	const summary =
		items.length === 0
			? "nothing scheduled"
			: `${items.length} ${items.length === 1 ? "item" : "items"}`;
	return (
		<div
			{...{ [CALENDAR_DAY_ATTRIBUTE]: key }}
			aria-current={isToday ? "date" : undefined}
			aria-label={`${longDay(date)}${isToday ? ", today" : ""}, ${summary}`}
			aria-selected={focused}
			className={cn(
				"@container relative flex min-h-0 min-w-0 flex-col gap-px overflow-hidden border-border border-r px-1 pb-px outline-none transition-colors last:border-r-0",
				"focus-visible:z-[1] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
			)}
			data-day-key={key}
			data-in-month={inMonth ? "true" : "false"}
			onClick={(event) => {
				if (event.target === event.currentTarget) {
					onSelectDay(key);
				}
			}}
			role="gridcell"
			tabIndex={focused ? 0 : -1}
		>
			<div className="flex h-6.5 shrink-0 items-center justify-center pt-0.5">
				<button
					aria-label={tl("Show the week of {day}", { day: longDay(date) })}
					className={cn(
						"flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 font-medium text-xs tabular-nums outline-none transition-colors",
						"hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
						isToday &&
							"bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
						// Another month's days keep the page's surface; only the date dims.
						!(isToday || inMonth) && "text-muted-foreground",
						focused && !isToday && "bg-muted text-foreground"
					)}
					onClick={() => onOpenDay(key)}
					tabIndex={-1}
					title="Show this week"
					type="button"
				>
					{cellDayLabel(date)}
				</button>
			</div>
			<div className="flex min-h-0 min-w-0 @max-[6rem]:flex-row flex-col @max-[6rem]:flex-wrap @max-[6rem]:justify-center gap-px">
				{shown.map((item) => (
					<CalendarChip
						handlers={handlers}
						item={item}
						key={item.key}
						tabStop={focused}
					/>
				))}
			</div>
			{hidden > 0 ? (
				<MoreButton
					date={date}
					handlers={handlers}
					hiddenCount={hidden}
					isToday={isToday}
					items={items}
					onOpenDay={onOpenDay}
					tabStop={focused}
				/>
			) : null}
		</div>
	);
}

/** Chips a month cell has room for, measured from the rendered grid. */
function useCellCapacity() {
	const bodyRef = useRef<HTMLDivElement>(null);
	const [capacity, setCapacity] = useState(DEFAULT_CAPACITY);
	useEffect(() => {
		const body = bodyRef.current;
		if (!body || typeof ResizeObserver === "undefined") {
			return;
		}
		const measure = () => {
			// A grid that has not laid out yet (or is hidden) keeps the default.
			if (body.clientHeight === 0) {
				return;
			}
			const byHeight = cellCapacity(body.clientHeight / 6);
			const next =
				body.clientWidth / 7 < NARROW_CELL_PX
					? Math.min(byHeight, NARROW_CAPACITY)
					: byHeight;
			setCapacity((current) => (current === next ? current : next));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(body);
		return () => observer.disconnect();
	}, []);
	return { bodyRef, capacity };
}

/**
 * Month: six weeks around the month, today marked, other months' days dimmed.
 * Each day lists its threads and runs by time, collapsing what does not fit
 * into "+N more".
 */
export function CalendarMonthGrid({
	anchor,
	days,
	direction,
	focusKey,
	handlers,
	itemsByDay,
	label,
	onOpenDay,
	onSelectDay,
	todayKey,
}: {
	anchor: Date;
	days: readonly Date[];
	/** Which way the last page turn went, for the enter motion. */
	direction: -1 | 0 | 1;
	focusKey: string;
	handlers: CalendarItemHandlers;
	itemsByDay: ReadonlyMap<string, CalendarItem[]>;
	label: string;
	onOpenDay: (key: string) => void;
	onSelectDay: (key: string) => void;
	todayKey: string;
}) {
	const reduceMotion = useReducedMotion();
	const { bodyRef, capacity } = useCellCapacity();
	const names = weekdayNames();
	const weeks: Date[][] = [];
	for (let index = 0; index < days.length; index += 7) {
		weeks.push(days.slice(index, index + 7));
	}
	const monthKey = `${anchor.getFullYear()}-${anchor.getMonth()}`;
	return (
		<div
			aria-label={label}
			className="flex min-h-0 min-w-0 flex-1 flex-col"
			data-calendar-zone="main"
			data-testid="calendar-month"
			role="grid"
		>
			<div
				className="grid shrink-0 grid-cols-7 border-border border-b"
				role="row"
			>
				{names.map((name) => (
					<div
						className={cn("truncate py-2 text-center", EYEBROW_CLASS)}
						key={name.short}
						role="columnheader"
					>
						<span className="max-sm:hidden">{name.short}</span>
						<span aria-hidden="true" className="sm:hidden">
							{name.narrow}
						</span>
					</div>
				))}
			</div>
			<div className="min-h-0 flex-1" ref={bodyRef}>
				<motion.div
					animate={{ opacity: 1, y: 0 }}
					className="grid size-full grid-rows-6"
					initial={
						reduceMotion || direction === 0
							? false
							: { opacity: 0, y: direction * 12 }
					}
					key={monthKey}
					role="rowgroup"
					transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
				>
					{weeks.map((week) => (
						<div
							className="grid min-h-0 grid-cols-7 border-border border-b last:border-b-0"
							key={localDayKey(week[0] ?? anchor)}
							role="row"
						>
							{week.map((date) => (
								<MonthCell
									capacity={capacity}
									date={date}
									focusKey={focusKey}
									handlers={handlers}
									inMonth={sameMonth(date, anchor)}
									items={itemsByDay.get(localDayKey(date)) ?? []}
									key={localDayKey(date)}
									onOpenDay={onOpenDay}
									onSelectDay={onSelectDay}
									todayKey={todayKey}
								/>
							))}
						</div>
					))}
				</motion.div>
			</div>
		</div>
	);
}
