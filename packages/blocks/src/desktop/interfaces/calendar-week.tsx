import { cn } from "@ryu/ui/lib/utils";
import { localDayKey } from "@ryuhq/protocol/interfaces";
import { ChevronDown, ChevronUp } from "lucide-react";
import { motion } from "motion/react";
import {
	type CSSProperties,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	CASCADE_MINUTES,
	type CalendarItem,
	compactTime,
	DEFAULT_COLUMN_PX,
	HOUR_PX,
	hourLabel,
	initialScrollMinute,
	isAggregate,
	layoutDay,
	longDay,
	MIN_BLOCK_PX,
	minuteOfDay,
	offscreenItems,
	type PlacedItem,
	timeZoneLabel,
	type WeekFold,
	weekdayShort,
} from "./calendar-model.ts";
import {
	CalendarChip,
	type CalendarItemHandlers,
	DayAgendaPopover,
} from "./calendar-month.tsx";
import {
	BlockAccent,
	blockToneClass,
	CALENDAR_DAY_ATTRIBUTE,
	CALENDAR_ITEM_ATTRIBUTE,
	ITEM_RADIUS_CLASS,
	itemAccessibleName,
	MICRO_TEXT_CLASS,
	RunPopover,
	threadTitle,
} from "./calendar-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const COLUMNS = "grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]";
/** Blocks shorter than this show one line: "Title, 9:16am". */
const TWO_LINE_PX = 34;
/** Blocks at least this tall give the title two lines before the time. */
const TALL_TITLE_PX = 52;

/** Gap between blocks that follow one another, or sit side by side. */
const BLOCK_GAP_PX = 2;
/** The time gutter's width (3.5rem), left of the seven day columns. */
const GUTTER_PX = 56;
/** A day column's block area is inset this much (4px left, 8px right). */
const COLUMN_INSET_PX = 12;

function blockStyle(placed: PlacedItem): CSSProperties {
	const top = (placed.topMinute / 60) * HOUR_PX;
	const height = Math.max(
		MIN_BLOCK_PX - BLOCK_GAP_PX,
		((placed.endMinute - placed.topMinute) / 60) * HOUR_PX - BLOCK_GAP_PX
	);
	return {
		height,
		left: placed.left,
		top,
		width: Math.max(4, placed.width - BLOCK_GAP_PX),
	};
}

/**
 * One block anatomy for every item: an opaque tint, an inset accent bar, a
 * medium title and a quieter time. Threads take their status tone; runs a
 * quieter fill, with the bar in their outcome's tone.
 */
function blockClassName(item: CalendarItem, active: boolean): string {
	return cn(
		"@container absolute flex items-start overflow-hidden ps-2.5 pe-1.5 text-left text-foreground text-xs leading-4 outline-none ring-1 ring-background transition-colors",
		ITEM_RADIUS_CLASS,
		"hover:z-[8]! focus-visible:z-[9]! focus-visible:ring-2 focus-visible:ring-ring",
		blockToneClass(item),
		// The open item: an inset ring, never a halo that spills onto its
		// neighbours.
		active && "z-[7]! ring-2 ring-ring ring-inset"
	);
}

function BlockBody({
	height,
	item,
	text,
}: {
	height: number;
	item: CalendarItem;
	text: boolean;
}) {
	const title =
		item.kind === "thread" ? threadTitle(item.thread) : item.event.title;
	const time = compactTime(item.start);
	if (!text) {
		// Too narrow for words: the tint and its bar, named by its label.
		return <BlockAccent item={item} />;
	}
	if (height < TWO_LINE_PX) {
		return (
			<>
				<BlockAccent item={item} />
				{/* "Title, 9:16am" as one line, like the reference: the time is
				    what truncation takes first, so the title keeps the room. */}
				<span className="min-w-0 flex-1 truncate py-0.5">
					<span className="font-medium">{title}</span>
					<span className="text-foreground/70 tabular-nums">, {time}</span>
				</span>
			</>
		);
	}
	return (
		<>
			<BlockAccent item={item} />
			<span className="flex min-w-0 flex-1 flex-col py-0.5">
				<span
					className={cn(
						"font-medium",
						// A narrow side-by-side block gives both lines to the title.
						height < TALL_TITLE_PX
							? "@max-[5rem]:line-clamp-2 truncate @max-[5rem]:whitespace-normal"
							: "line-clamp-2"
					)}
				>
					{title}
				</span>
				<span className="@max-[5rem]:hidden truncate text-foreground/70 tabular-nums">
					{time}
				</span>
			</span>
		</>
	);
}

function WeekBlock({
	handlers,
	placed,
	tabStop,
}: {
	handlers: CalendarItemHandlers;
	placed: PlacedItem;
	tabStop: boolean;
}) {
	const { item } = placed;
	const style = blockStyle(placed);
	// Lines are laid out for the part a later, cascaded block leaves in view.
	const height = Math.min(
		Number(style.height),
		((placed.openUntilMinute - placed.topMinute) / 60) * HOUR_PX - BLOCK_GAP_PX
	);
	if (item.kind === "run") {
		const open = handlers.openRunKey === item.key;
		return (
			<RunPopover
				active={open}
				className={blockClassName(item, open)}
				item={item}
				onMessage={handlers.onMessage}
				onOpenChange={(next) =>
					handlers.onOpenRunChange(next ? item.key : null)
				}
				open={open}
				snapshot={handlers.snapshot}
				style={style}
				tabStop={tabStop}
			>
				<BlockBody height={height} item={item} text={placed.text} />
			</RunPopover>
		);
	}
	const active = handlers.activeThreadId === item.thread.id;
	return (
		<button
			{...{ [CALENDAR_ITEM_ATTRIBUTE]: item.key }}
			aria-current={active ? "true" : undefined}
			aria-label={itemAccessibleName(handlers.snapshot, item)}
			className={blockClassName(item, active)}
			data-thread-id={item.thread.id}
			onClick={() => handlers.onOpenThread(item.thread.id)}
			style={style}
			tabIndex={tabStop ? 0 : -1}
			title={`${threadTitle(item.thread)} · ${compactTime(item.start)}`}
			type="button"
		>
			<BlockBody height={height} item={item} text={placed.text} />
		</button>
	);
}

/**
 * The current time. Today's column gets the strong line and its dot, drawn
 * over the blocks as the reference calendars draw it; the rest of the week
 * a faint guide under them.
 */
function NowLine({ now, today }: { now: Date; today: boolean }) {
	const top = (minuteOfDay(now) / 60) * HOUR_PX;
	if (!today) {
		return (
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-0 z-[1] h-px bg-primary/35"
				style={{ top: top - 0.5 }}
			/>
		);
	}
	return (
		<>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-0 z-[5] h-0.5 bg-primary"
				data-calendar-now=""
				style={{ top: top - 1 }}
			/>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute -start-1.5 z-[5] size-3 rounded-full bg-primary"
				style={{ top: top - 6 }}
			/>
		</>
	);
}

/**
 * "+N" at the edge of a crowded row: the blocks it has no room for, listed
 * in the day's agenda popover.
 */
function FoldButton({
	date,
	fold,
	handlers,
	isToday,
	items,
	tabStop,
}: {
	date: Date;
	fold: WeekFold;
	handlers: CalendarItemHandlers;
	isToday: boolean;
	items: readonly CalendarItem[];
	tabStop: boolean;
}) {
	const count = fold.items.length;
	return (
		<DayAgendaPopover
			date={date}
			handlers={handlers}
			isToday={isToday}
			items={items}
			side="right"
			sideOffset={6}
			style={{
				height: (CASCADE_MINUTES / 60) * HOUR_PX - BLOCK_GAP_PX,
				left: fold.left,
				top: (fold.topMinute / 60) * HOUR_PX,
				width: fold.width - BLOCK_GAP_PX,
			}}
			tabStop={tabStop}
			triggerClassName={cn(
				"absolute flex items-center justify-center bg-muted font-medium text-muted-foreground text-xs tabular-nums outline-none ring-1 ring-background transition-colors",
				ITEM_RADIUS_CLASS,
				"hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-accent aria-expanded:text-foreground"
			)}
			triggerLabel={`${count} more at ${compactTime(fold.items[0]?.start ?? date)} on ${longDay(date)}`}
		>
			+{count}
		</DayAgendaPopover>
	);
}

/** The visible hours are tracked in steps this coarse, to keep scrolling cheap. */
const VIEW_STEP_MINUTES = 5;
/** An hour label within this many minutes of an edge would be cut: hide it. */
const LABEL_EDGE_MINUTES = 7;

/**
 * The scroll offset that opens a week on an hour: its line sits flush under
 * the header's rule (one pixel past it, so the two never double up), and
 * its label is left out, as the reference leaves out midnight's.
 */
function hourOffset(minute: number): number {
	return minute > 0 ? (minute / 60) * HOUR_PX + 1 : 0;
}

/** Whether an hour line sits too close to the scrolled edges for its label. */
function labelClipped(hour: number, range: VisibleMinutes | null): boolean {
	if (!range) {
		return false;
	}
	const minute = hour * 60;
	return (
		Math.abs(minute - range.from) < LABEL_EDGE_MINUTES ||
		Math.abs(range.to - minute) < LABEL_EDGE_MINUTES
	);
}

interface VisibleMinutes {
	from: number;
	to: number;
}

/**
 * Which hours the week scroller shows, and how wide a day's block area is,
 * kept current on scroll and resize.
 */
function useVisibleMinutes(scrollerRef: { current: HTMLDivElement | null }) {
	const [range, setRange] = useState<VisibleMinutes | null>(null);
	const [columnWidth, setColumnWidth] = useState(DEFAULT_COLUMN_PX);
	const refresh = useCallback(() => {
		const scroller = scrollerRef.current;
		if (!scroller || scroller.clientHeight === 0) {
			return;
		}
		const width = Math.floor(
			(scroller.clientWidth - GUTTER_PX) / 7 - COLUMN_INSET_PX
		);
		setColumnWidth((current) => (current === width ? current : width));
		const toMinutes = (px: number) =>
			Math.round((px / HOUR_PX) * (60 / VIEW_STEP_MINUTES)) * VIEW_STEP_MINUTES;
		const from = toMinutes(scroller.scrollTop);
		const to = toMinutes(scroller.scrollTop + scroller.clientHeight);
		setRange((current) =>
			current?.from === from && current.to === to ? current : { from, to }
		);
	}, [scrollerRef]);
	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller) {
			return;
		}
		scroller.addEventListener("scroll", refresh, { passive: true });
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(refresh);
		observer?.observe(scroller);
		return () => {
			scroller.removeEventListener("scroll", refresh);
			observer?.disconnect();
		};
	}, [refresh, scrollerRef]);
	return { columnWidth, range, refresh };
}

/**
 * "↑ 2 earlier" / "↓ 1 later": a column's blocks scrolled out of view, like
 * the reference calendars' hints. Choosing it scrolls the first one in.
 */
function OffscreenHint({
	count,
	date,
	direction,
	onReveal,
	tabStop,
}: {
	count: number;
	date: Date;
	direction: "earlier" | "later";
	onReveal: () => void;
	tabStop: boolean;
}) {
	const Icon = direction === "earlier" ? ChevronUp : ChevronDown;
	return (
		<button
			aria-label={`${count} ${direction} ${count === 1 ? "item" : "items"} on ${longDay(date)}, show`}
			className={cn(
				"pointer-events-auto absolute inset-x-0 mx-auto flex h-5 w-fit max-w-[calc(100%-8px)] items-center gap-0.5 bg-background ps-1 pe-1.5 font-medium text-muted-foreground text-xs tabular-nums outline-none transition-colors",
				ITEM_RADIUS_CLASS,
				"hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
				direction === "earlier" ? "top-1" : "bottom-1"
			)}
			onClick={onReveal}
			tabIndex={tabStop ? 0 : -1}
			type="button"
		>
			<Icon aria-hidden="true" className="size-3.5 shrink-0" />
			<span className="truncate">
				{count}
				<span className="@max-[4.5rem]:hidden"> {direction}</span>
			</span>
		</button>
	);
}

/**
 * A zero-height row pinned to the top or bottom edge of the scrolled hours,
 * lined up with the day columns, that carries the off-screen hints.
 */
function HintRow({
	cells,
	edge,
}: {
	cells: readonly { content: ReactNode; key: string }[];
	edge: "bottom" | "top";
}) {
	return (
		<div
			className={cn(
				"pointer-events-none sticky z-10 grid h-0",
				COLUMNS,
				edge === "top" ? "top-0" : "bottom-0"
			)}
		>
			<span />
			{cells.map((cell) => (
				<div className="@container relative" key={cell.key}>
					{cell.content}
				</div>
			))}
		</div>
	);
}

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
