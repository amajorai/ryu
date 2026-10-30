import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	type TimelineDay,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	hourLabel,
	hourRangeLabel,
	type PlacedChip,
	timeOfDay,
	WEEK_CHIP_PX,
	WEEK_GUTTER_REM,
	type WeekRow,
	weekColumnLabel,
	weekColumnTracks,
	weekLayout,
} from "./timeline-model.ts";
import {
	TIMELINE_EVENT_ATTRIBUTE,
	threadAccessibleName,
	threadTitle,
} from "./timeline-parts.tsx";
import { TIMELINE_STATUS_BAR, TimelineStatusDot } from "./timeline-status.tsx";
import {
	type HiddenDays,
	TimelineWeekReveal,
} from "./timeline-week-reveal.tsx";

/** DOM id of a week column's heading, so "Today" can move focus to it. */
export function timelineWeekHeadingId(key: string): string {
	return `timeline-week-${key}`;
}

/** Attribute on today's "now" line, so "Today" can scroll it into view. */
export const TIMELINE_NOW_ATTRIBUTE = "data-timeline-now";

/** Room kept free at the grid's right edge, so today's chips never meet the viewport. */
const LAST_COLUMN_INSET = "right-3";

function WeekChip({
	active,
	chip,
	column,
	onOpen,
	row,
	snapshot,
	tabStop,
}: {
	active: boolean;
	chip: PlacedChip;
	column: number;
	onOpen: (threadId: string) => void;
	row: number;
	snapshot: InterfaceSnapshot;
	tabStop: boolean;
}) {
	const { thread } = chip;
	const status = threadStatus(thread);
	return (
		<button
			{...{ [TIMELINE_EVENT_ATTRIBUTE]: "" }}
			aria-current={active ? "true" : undefined}
			aria-label={threadAccessibleName(snapshot, thread)}
			className={cn(
				"@container absolute inset-x-0 z-[1] flex items-center gap-2 overflow-hidden rounded-sm bg-muted pr-2 pl-2.5 text-left text-foreground outline-none transition-colors duration-150 motion-reduce:transition-none",
				"hover:bg-accent focus-visible:z-[3] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
				// The same selected treatment as a Day row: accent, plus a primary edge.
				active &&
					"z-[2] bg-accent text-accent-foreground ring-1 ring-primary/50 ring-inset"
			)}
			data-column={column}
			data-row={row}
			data-status={status}
			data-thread-id={thread.id}
			onClick={() => onOpen(thread.id)}
			style={{ height: WEEK_CHIP_PX - 2, top: chip.top }}
			tabIndex={tabStop ? 0 : -1}
			title={`${threadTitle(thread)} · ${timeOfDay(thread.updatedAt)}`}
			type="button"
		>
			{/* The status is the chip's left edge, clipped by its radius. */}
			<span
				aria-hidden="true"
				className={cn(
					"absolute inset-y-0 left-0 w-0.5",
					TIMELINE_STATUS_BAR[status]
				)}
			/>
			{/*
			 * One line, as a calendar draws a short event: the title, then the
			 * time. A narrow chip drops the time (its hour row still gives it,
			 * and the tooltip the exact one): the title always stays.
			 */}
			<span className="min-w-0 flex-1 truncate font-medium text-xs leading-4">
				{threadTitle(thread)}
			</span>
			<span
				className={cn(
					"flex @max-[11.5rem]:hidden shrink-0 items-center gap-1 text-muted-foreground text-xs tabular-nums leading-4",
					active && "text-accent-foreground/70"
				)}
			>
				{status === "working" ? <TimelineStatusDot status={status} /> : null}
				{timeOfDay(thread.updatedAt)}
			</span>
		</button>
	);
}

/**
 * Today's "now" line. The layout places it after the chips already in its
 * hour, so it never runs through one; the dot sits on the column's edge.
 */
function NowLine({ top }: { top: number }) {
	return (
		<>
			<div
				{...{ [TIMELINE_NOW_ATTRIBUTE]: "" }}
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-0 z-0 h-px -translate-y-1/2 bg-primary"
				style={{ top }}
			/>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute left-0 z-[3] size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary"
				style={{ top }}
			/>
		</>
	);
}

/**
 * Days scrolled out of view on either side of a sideways-scrolling grid, so
 * the gutter can say they exist and bring them back.
 */
function useHiddenDays(compact: boolean) {
	const scrollerRef = useRef<HTMLDivElement>(null);
	const [hidden, setHidden] = useState<HiddenDays>({ after: 0, before: 0 });
	/** Height free for the hour rows under the sticky day headings. */
	const [fillPx, setFillPx] = useState(0);

	const measure = useCallback(() => {
		const scroller = scrollerRef.current;
		if (!scroller) {
			return;
		}
		const gutter = scroller.querySelector<HTMLElement>("[data-week-gutter]");
		const head = scroller.querySelector<HTMLElement>("[data-week-head]");
		const free = Math.max(0, scroller.clientHeight - (head?.offsetHeight ?? 0));
		setFillPx((current) => (current === free ? current : free));
		const view = scroller.getBoundingClientRect();
		const left = view.left + (gutter?.offsetWidth ?? 0);
		const right = view.left + scroller.clientWidth;
		let before = 0;
		let after = 0;
		for (const heading of scroller.querySelectorAll<HTMLElement>(
			"[data-week-day-heading]"
		)) {
			// A day counts as hidden once any of it is cut off.
			const rect = heading.getBoundingClientRect();
			if (rect.left < left - 1) {
				before += 1;
			} else if (rect.right > right + 1) {
				after += 1;
			}
		}
		setHidden((current) =>
			current.before === before && current.after === after
				? current
				: { after, before }
		);
	}, []);

	// Open on the newest days: a narrow grid scrolls sideways, today is last.
	// Opening or closing a thread changes the width, so it re-anchors then too.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `compact` is the trigger, not an input.
	useLayoutEffect(() => {
		const scroller = scrollerRef.current;
		if (scroller) {
			scroller.scrollLeft = scroller.scrollWidth;
		}
		measure();
	}, [compact, measure]);

	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(scroller);
		return () => observer.disconnect();
	}, [measure]);

	const reveal = (side: "before" | "after") => {
		const scroller = scrollerRef.current;
		if (scroller) {
			scroller.scrollLeft = side === "before" ? 0 : scroller.scrollWidth;
		}
	};

	return { fillPx, hidden, measure, reveal, scrollerRef };
}

/** Gutter labels and rules for the hour rows, shared by every day column. */
function WeekHourGutter({ rows }: { rows: readonly WeekRow[] }) {
	return (
		<div aria-hidden="true" className="sticky left-0 z-[4] bg-background">
			{rows.map((row, index) => {
				if (row.quiet) {
					return (
						<span
							className="absolute right-2 flex items-center whitespace-nowrap text-[11px] text-muted-foreground tabular-nums leading-4"
							key={row.fromHour}
							style={{ height: row.height, top: row.top }}
						>
							{hourRangeLabel(row.fromHour, row.toHour)}
						</span>
					);
				}
				// A folded run above already names this hour as its end.
				if (rows[index - 1]?.quiet) {
					return null;
				}
				return (
					<span
						className={cn(
							"absolute right-2 whitespace-nowrap text-[11px] text-muted-foreground tabular-nums leading-4",
							// The first label hangs under its line instead of under the header.
							index === 0 ? "translate-y-0.5" : "-translate-y-1/2"
						)}
						key={row.fromHour}
						style={{ top: row.top }}
					>
						{hourLabel(row.fromHour)}
					</span>
				);
			})}
		</div>
	);
}

/** Hour lines across the days, dashed on both edges of a folded run of empty hours. */
function WeekHourRules({ rows }: { rows: readonly WeekRow[] }) {
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-y-0 right-0"
			style={{ left: `${WEEK_GUTTER_REM}rem` }}
		>
			{rows.map((row, index) => {
				// The grid's top edge is the header's rule.
				if (index === 0) {
					return null;
				}
				// A folded run sits between two dashed rules: the break in time.
				const folded = row.quiet || rows[index - 1]?.quiet === true;
				return (
					<span
						className={cn(
							"absolute inset-x-0 border-t",
							folded ? "border-border border-dashed" : "border-border/70"
						)}
						key={row.fromHour}
						style={{ top: row.top }}
					/>
				);
			})}
		</div>
	);
}

/**
 * Week scale: the seven days ending today, oldest on the left, with an hour
 * gutter fitted to the data. Threads sit in the hour of their latest
 * activity; threads in the same hour stack full width, in time order.
 */
export function TimelineWeekGrid({
	activeThreadId,
	compact,
	days,
	highlightKey,
	now,
	onOpen,
	preferredTabStop,
	snapshot,
	threadsById,
}: {
	activeThreadId: string | null;
	/** A thread is open beside the grid: empty days give up their width. */
	compact: boolean;
	days: readonly TimelineDay[];
	/** A day just jumped to, briefly tinted so the jump is visible. */
	highlightKey: string | null;
	now: Date;
	onOpen: (threadId: string) => void;
	/** The thread that should hold the grid's single Tab stop, if shown. */
	preferredTabStop: string | null;
	snapshot: InterfaceSnapshot;
	threadsById: ReadonlyMap<string, InterfaceThread>;
}) {
	const tl = useLiteralMessages();
	const todayKey = localDayKey(now);
	const columns = days.map((day) =>
		day.threadIds.flatMap((id) => {
			const thread = threadsById.get(id);
			return thread ? [thread] : [];
		})
	);
	const { fillPx, hidden, measure, reveal, scrollerRef } =
		useHiddenDays(compact);
	const layout = weekLayout(
		columns,
		now,
		days.findIndex((day) => day.key === todayKey),
		fillPx
	);
	const tracks = weekColumnTracks(
		columns.map((threads) => threads.length),
		compact
	);
	const gridStyle: CSSProperties = { gridTemplateColumns: tracks.template };
	const placedIds = new Set(
		layout.chips.flatMap((chips) => chips.map((chip) => chip.thread.id))
	);
	const tabStopId =
		preferredTabStop && placedIds.has(preferredTabStop)
			? preferredTabStop
			: (layout.chips.find((chips) => chips.length > 0)?.[0]?.thread.id ??
				null);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div
				className="min-h-0 flex-1 overflow-auto"
				data-timeline-week-scroller=""
				onScroll={measure}
				ref={scrollerRef}
			>
				<div
					className="flex flex-col"
					style={{ minWidth: `${tracks.minWidthRem}rem` }}
				>
					<div
						className="sticky top-0 z-10 grid h-14 shrink-0 border-border border-b bg-background"
						data-week-head=""
						style={gridStyle}
					>
						<div
							className="sticky left-0 z-[1] flex flex-col items-center justify-center gap-1 bg-background"
							data-week-gutter=""
						>
							<TimelineWeekReveal hidden={hidden} onReveal={reveal} />
						</div>
						{days.map((day, index) => {
							const label = weekColumnLabel(day.key);
							const isToday = day.key === todayKey;
							const count = columns[index]?.length ?? 0;
							const highlighted = day.key === highlightKey;
							return (
								<h3
									aria-label={`${isToday ? "Today, " : ""}${label.full}, ${count} ${
										count === 1 ? "thread" : "threads"
									}`}
									className={cn(
										"@container relative flex min-w-0 flex-col items-center justify-center gap-0.5 border-border border-l outline-none transition-colors duration-500 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
										highlighted && "bg-primary/10"
									)}
									data-highlight={highlighted ? "" : undefined}
									data-week-day-heading=""
									id={timelineWeekHeadingId(day.key)}
									key={day.key}
									tabIndex={-1}
									title={label.full}
								>
									<span
										className={cn(
											"font-medium text-muted-foreground text-xs leading-4",
											isToday && "text-primary"
										)}
									>
										<span className="@max-[2.75rem]:hidden">
											{label.weekday}
										</span>
										<span className="@min-[2.75rem]:hidden">
											{label.initial}
										</span>
									</span>
									<span
										className={cn(
											"flex @max-[2rem]:size-6 size-7 items-center justify-center rounded-full font-semibold @max-[2rem]:text-xs text-sm tabular-nums",
											count === 0 && !isToday && "text-muted-foreground",
											isToday && "bg-primary text-primary-foreground"
										)}
									>
										{label.dayOfMonth}
									</span>
								</h3>
							);
						})}
					</div>
					<div
						className="relative grid shrink-0"
						style={{ ...gridStyle, height: layout.height }}
					>
						<WeekHourGutter rows={layout.rows} />
						<WeekHourRules rows={layout.rows} />
						{days.map((day, columnIndex) => {
							const isToday = day.key === todayKey;
							const label = weekColumnLabel(day.key);
							const chips = layout.chips[columnIndex] ?? [];
							const highlighted = day.key === highlightKey;
							const isLast = columnIndex === days.length - 1;
							return (
								<section
									aria-label={
										isToday
											? tl("Today, {dayLabel}", { dayLabel: label.full })
											: label.full
									}
									className={cn(
										"relative min-w-0 border-border border-l transition-colors duration-500 motion-reduce:transition-none",
										highlighted && "bg-primary/5"
									)}
									data-day-key={day.key}
									data-highlight={highlighted ? "" : undefined}
									key={day.key}
								>
									<div
										className={cn(
											"absolute inset-y-0 left-1",
											isLast ? LAST_COLUMN_INSET : "right-1"
										)}
									>
										{chips.map((chip, row) => (
											<WeekChip
												active={chip.thread.id === activeThreadId}
												chip={chip}
												column={columnIndex}
												key={chip.thread.id}
												onOpen={onOpen}
												row={row}
												snapshot={snapshot}
												tabStop={chip.thread.id === tabStopId}
											/>
										))}
									</div>
									{isToday && layout.nowTop !== null ? (
										<NowLine top={layout.nowTop} />
									) : null}
								</section>
							);
						})}
					</div>
				</div>
			</div>
		</div>
	);
}
