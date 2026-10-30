import { cn } from "@ryu/ui/lib/utils";
import { localDayKey } from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import { useLayoutEffect, useRef } from "react";
import {
	type CalendarItem,
	HOUR_PX,
	hourLabel,
	initialScrollMinute,
	isAggregate,
	layoutDay,
	longDay,
	minuteOfDay,
	offscreenItems,
	timeZoneLabel,
	weekdayShort,
} from "./calendar-model.ts";
import { CalendarChip, type CalendarItemHandlers } from "./calendar-month.tsx";
import { CALENDAR_DAY_ATTRIBUTE, MICRO_TEXT_CLASS } from "./calendar-parts.tsx";
import { FoldButton, NowLine, WeekBlock } from "./calendar-week-blocks.tsx";
import {
	COLUMNS,
	HintRow,
	hourOffset,
	labelClipped,
	OffscreenHint,
	useVisibleMinutes,
} from "./calendar-week-scroll.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/**
 * Week: seven day columns over a 24-hour axis. Threads sit at their latest
 * activity and runs at their start; overlapping items share the column side
 * by side. Aggregated runs ("×24") stand for a whole day of runs, so they sit
 * in the all-day row instead of at one hour.
 */
export function CalendarWeekGrid({
	days,
	direction,
	focusKey,
	handlers,
	itemsByDay,
	label,
	now,
	onSelectDay,
	todayKey,
}: {
	days: readonly Date[];
	direction: -1 | 0 | 1;
	focusKey: string;
	handlers: CalendarItemHandlers;
	itemsByDay: ReadonlyMap<string, CalendarItem[]>;
	label: string;
	now: Date;
	onSelectDay: (key: string) => void;
	todayKey: string;
}) {
	const reduceMotion = useReducedMotion();
	const scrollerRef = useRef<HTMLDivElement>(null);
	const view = useVisibleMinutes(scrollerRef);
	const keepKey = handlers.activeThreadId
		? `thread:${handlers.activeThreadId}`
		: null;
	const columns = days.map((date) => {
		const key = localDayKey(date);
		const items = itemsByDay.get(key) ?? [];
		const layout = layoutDay(
			items.filter((item) => !isAggregate(item)),
			view.columnWidth,
			keepKey
		);
		return {
			allDay: items.filter(isAggregate),
			date,
			folds: layout.folds,
			items,
			key,
			placed: layout.blocks,
			total: items.length,
		};
	});
	const weekKey = columns[0]?.key ?? todayKey;
	const showsToday = columns.some((column) => column.key === todayKey);

	// Open each week above its first item (or around now), like a calendar.
	const blockMinutes = columns.flatMap((column) =>
		column.placed.map((placed) => placed.topMinute)
	);
	const nowMinute = showsToday ? minuteOfDay(now) : null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll only when the week changes, not on every refresh of now.
	useLayoutEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller) {
			return;
		}
		// Late in the day the grid cannot scroll that far: open on the last
		// hour line it can reach, never mid-hour.
		const maxTop = scroller.scrollHeight - scroller.clientHeight;
		let minute = initialScrollMinute(blockMinutes, nowMinute);
		while (minute > 0 && hourOffset(minute) > maxTop) {
			minute -= 60;
		}
		scroller.scrollTop = hourOffset(minute);
		view.refresh();
	}, [weekKey]);
	const hints = columns.map((column) => {
		// A fold stands for all the blocks it holds.
		const entries = [
			...column.placed.map((placed) => ({ ...placed, count: 1 })),
			...column.folds.map((fold) => ({ ...fold, count: fold.items.length })),
		].sort((a, b) => a.topMinute - b.topMinute);
		const { above, below } = view.range
			? offscreenItems(entries, view.range.from, view.range.to)
			: { above: [], below: [] };
		const total = (list: readonly { count: number }[]) =>
			list.reduce((sum, entry) => sum + entry.count, 0);
		return {
			above,
			aboveCount: total(above),
			below,
			belowCount: total(below),
			date: column.date,
			key: column.key,
		};
	});
	/** Bring a hidden block into view, with its hour line above it. */
	const revealMinute = (minute: number) => {
		scrollerRef.current?.scrollTo({
			behavior: reduceMotion ? "auto" : "smooth",
			top: hourOffset(Math.floor((minute - 15) / 60) * 60),
		});
	};

	return (
		<div
			aria-label={label}
			className="flex min-h-0 min-w-0 flex-1 flex-col"
			data-calendar-zone="main"
			data-testid="calendar-week"
			role="group"
		>
			<div className={cn("grid shrink-0", COLUMNS)}>
				<div aria-hidden="true" />
				{columns.map((column) => {
					const isToday = column.key === todayKey;
					const focused = column.key === focusKey;
					return (
						<button
							{...{ [CALENDAR_DAY_ATTRIBUTE]: column.key }}
							aria-current={isToday ? "date" : undefined}
							aria-label={`${longDay(column.date)}${isToday ? ", today" : ""}, ${column.total} ${column.total === 1 ? "item" : "items"}`}
							aria-pressed={focused}
							className={cn(
								"group/day flex min-w-0 flex-col items-center gap-1 border-border border-l pt-2 pb-1.5 outline-none transition-colors",
								"hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
							)}
							data-day-key={column.key}
							key={column.key}
							onClick={() => onSelectDay(column.key)}
							tabIndex={focused ? 0 : -1}
							type="button"
						>
							<span
								className={cn(
									MICRO_TEXT_CLASS,
									"uppercase tracking-wider",
									focused ? "font-bold" : "font-medium",
									isToday && "text-primary",
									!isToday &&
										(focused ? "text-foreground" : "text-muted-foreground")
								)}
							>
								{weekdayShort(column.date)}
							</span>
							<span
								className={cn(
									"flex size-10 items-center justify-center rounded-full font-heading text-2xl tabular-nums leading-none transition-colors max-md:size-8 max-md:text-lg",
									isToday
										? "bg-primary text-primary-foreground"
										: "text-foreground group-hover/day:bg-muted",
									// The roving day: a ring and a bold weekday, so it reads apart from hover.
									focused && !isToday && "bg-muted ring-1 ring-border"
								)}
							>
								{column.date.getDate()}
							</span>
						</button>
					);
				})}
				{/* The all-day row, always present like the reference's: its gutter
				    names the time zone the hour axis is in. */}
				<div
					className={cn(
						"flex min-h-6 items-end justify-end border-border border-b pe-2 pb-1 text-muted-foreground",
						MICRO_TEXT_CLASS
					)}
					title="Time zone"
				>
					{timeZoneLabel(now)}
				</div>
				{columns.map((column) => (
					<div
						className="@container flex min-h-6 min-w-0 flex-col gap-px border-border border-b border-l px-1 py-0.5"
						key={column.key}
					>
						{column.allDay.map((item) => (
							<CalendarChip
								handlers={handlers}
								item={item}
								key={item.key}
								tabStop={column.key === focusKey}
							/>
						))}
					</div>
				))}
			</div>
			<div
				className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				ref={scrollerRef}
			>
				<HintRow
					cells={hints.map((hint) => ({
						content:
							hint.above.length > 0 ? (
								<OffscreenHint
									count={hint.aboveCount}
									date={hint.date}
									direction="earlier"
									onReveal={() =>
										revealMinute(hint.above.at(-1)?.topMinute ?? 0)
									}
									tabStop={hint.key === focusKey}
								/>
							) : null,
						key: hint.key,
					}))}
					edge="top"
				/>
				<motion.div
					animate={{ opacity: 1, x: 0 }}
					className={cn("relative grid", COLUMNS)}
					initial={
						reduceMotion || direction === 0
							? false
							: { opacity: 0, x: direction * 16 }
					}
					key={weekKey}
					style={{ height: HOUR_PX * 24 }}
					transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
				>
					<div aria-hidden="true" className="relative">
						{HOURS.slice(1).map((hour) =>
							labelClipped(hour, view.range) ? null : (
								<span
									className={cn(
										"absolute end-2 -translate-y-1/2 text-muted-foreground tabular-nums",
										MICRO_TEXT_CLASS
									)}
									key={hour}
									style={{ top: hour * HOUR_PX }}
								>
									{hourLabel(hour)}
								</span>
							)
						)}
					</div>
					{columns.map((column) => (
						<section
							aria-label={longDay(column.date)}
							className="relative border-border border-l"
							key={column.key}
						>
							{HOURS.slice(1).map((hour) => (
								<span
									aria-hidden="true"
									className="pointer-events-none absolute inset-x-0 border-border/70 border-t"
									key={hour}
									style={{ top: hour * HOUR_PX }}
								/>
							))}
							<div className="absolute inset-y-0 start-1 end-2 z-[2]">
								{column.placed.map((placed) => (
									<WeekBlock
										handlers={handlers}
										key={placed.item.key}
										placed={placed}
										tabStop={column.key === focusKey}
									/>
								))}
								{column.folds.map((fold) => (
									<FoldButton
										date={column.date}
										fold={fold}
										handlers={handlers}
										isToday={column.key === todayKey}
										items={column.items}
										key={fold.key}
										tabStop={column.key === focusKey}
									/>
								))}
							</div>
							{showsToday ? (
								<NowLine now={now} today={column.key === todayKey} />
							) : null}
						</section>
					))}
				</motion.div>
				<HintRow
					cells={hints.map((hint) => ({
						content:
							hint.below.length > 0 ? (
								<OffscreenHint
									count={hint.belowCount}
									date={hint.date}
									direction="later"
									onReveal={() => revealMinute(hint.below[0]?.topMinute ?? 0)}
									tabStop={hint.key === focusKey}
								/>
							) : null,
						key: hint.key,
					}))}
					edge="bottom"
				/>
			</div>
		</div>
	);
}
