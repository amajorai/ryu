import { Button } from "@ryu/ui/components/button.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	localDayKey,
} from "@ryuhq/protocol/interfaces";
import { ArrowRight, ChevronLeft, X } from "lucide-react";
import { motion } from "motion/react";
import {
	type CSSProperties,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type CalendarItem,
	cellCapacity,
	cellDayLabel,
	cellItems,
	compactTime,
	isAggregate,
	longDay,
	type RunItem,
	sameMonth,
	weekdayNames,
	weekdayShort,
} from "./calendar-model.ts";
import {
	ACTIVE_ITEM_CLASS,
	CALENDAR_DAY_ATTRIBUTE,
	CALENDAR_ITEM_ATTRIBUTE,
	ChipBody,
	chipClassName,
	EYEBROW_CLASS,
	ITEM_RADIUS_CLASS,
	ItemMark,
	itemAccessibleName,
	RunDetails,
	RunPopover,
	threadTitle,
} from "./calendar-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const DEFAULT_CAPACITY = 4;
/**
 * A phone-width cell draws its items as bare dots: three of them and a
 * "+N" are all it shows, however tall it is.
 */
const NARROW_CELL_PX = 96;
const NARROW_CAPACITY = 4;

export interface CalendarItemHandlers {
	activeThreadId: string | null;
	onMessage: (agentId: string) => void;
	onOpenRunChange: (key: string | null) => void;
	onOpenThread: (threadId: string) => void;
	openRunKey: string | null;
	snapshot: InterfaceSnapshot;
}

/** One item as a chip: a thread button, or a run that opens its popover. */
export function CalendarChip({
	handlers,
	item,
	tabStop,
}: {
	handlers: CalendarItemHandlers;
	item: CalendarItem;
	tabStop: boolean;
}) {
	if (item.kind === "run") {
		return (
			<RunPopover
				className={chipClassName(item, handlers.openRunKey === item.key)}
				item={item}
				onMessage={handlers.onMessage}
				onOpenChange={(open) =>
					handlers.onOpenRunChange(open ? item.key : null)
				}
				open={handlers.openRunKey === item.key}
				snapshot={handlers.snapshot}
				tabStop={tabStop}
			>
				<ChipBody item={item} />
			</RunPopover>
		);
	}
	const active = handlers.activeThreadId === item.thread.id;
	return (
		<button
			{...{ [CALENDAR_ITEM_ATTRIBUTE]: item.key }}
			aria-current={active ? "true" : undefined}
			aria-label={itemAccessibleName(handlers.snapshot, item)}
			className={chipClassName(item, active)}
			data-thread-id={item.thread.id}
			onClick={() => handlers.onOpenThread(item.thread.id)}
			tabIndex={tabStop ? 0 : -1}
			title={item.thread.title}
			type="button"
		>
			<ChipBody item={item} />
		</button>
	);
}

/**
 * One line of a day's agenda, like the reference calendars' day popover: a
 * fixed time column (or "All day" for an aggregate), the mark, the title.
 */
function AgendaRow({
	active,
	item,
	onChoose,
	snapshot,
}: {
	active: boolean;
	item: CalendarItem;
	onChoose: () => void;
	snapshot: InterfaceSnapshot;
}) {
	const title =
		item.kind === "thread" ? threadTitle(item.thread) : item.event.title;
	const upcoming = item.kind === "run" && item.event.kind === "upcoming";
	return (
		<button
			aria-current={active ? "true" : undefined}
			aria-label={itemAccessibleName(snapshot, item)}
			className={cn(
				"flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-xs outline-none transition-colors",
				"hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
				active && ACTIVE_ITEM_CLASS
			)}
			onClick={onChoose}
			type="button"
		>
			<span className="w-14 shrink-0 text-muted-foreground tabular-nums">
				{isAggregate(item) ? "All day" : compactTime(item.start)}
			</span>
			<ItemMark item={item} />
			<span
				className={cn(
					"min-w-0 flex-1 truncate font-medium",
					upcoming ? "text-muted-foreground" : "text-foreground"
				)}
			>
				{title}
			</span>
		</button>
	);
}

/**
 * A day's full agenda in a popover, opened from a month cell's "+N more" or
 * a week row's "+N". Threads open in the side panel; a run swaps the list
 * for its details, with a way back.
 */
export function DayAgendaPopover({
	children,
	date,
	handlers,
	isToday,
	items,
	onOpenDay,
	side = "bottom",
	sideOffset = -28,
	style,
	tabStop,
	triggerClassName,
	triggerLabel,
}: {
	children: ReactNode;
	date: Date;
	handlers: CalendarItemHandlers;
	isToday: boolean;
	items: readonly CalendarItem[];
	/** Open the day's week; the week grid, already there, leaves it out. */
	onOpenDay?: (key: string) => void;
	side?: "bottom" | "right";
	sideOffset?: number;
	style?: CSSProperties;
	tabStop: boolean;
	triggerClassName: string;
	triggerLabel: string;
}) {
	const [open, setOpen] = useState(false);
	const [detail, setDetail] = useState<RunItem | null>(null);
	return (
		<Popover
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setDetail(null);
				}
			}}
			open={open}
		>
			<PopoverTrigger
				aria-label={triggerLabel}
				className={triggerClassName}
				style={style}
				tabIndex={tabStop ? 0 : -1}
				type="button"
			>
				{children}
			</PopoverTrigger>
			<PopoverContent
				align="center"
				appearance="composer-menu"
				className="w-72 max-w-[calc(100vw-2rem)]"
				corners="rounded"
				side={side}
				sideOffset={sideOffset}
				spacing="inset"
			>
				{detail ? (
					<div className="flex flex-col gap-2 p-2">
						<button
							className="-ms-1 flex w-fit items-center gap-1 rounded-md px-1 py-0.5 text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => setDetail(null)}
							type="button"
						>
							<ChevronLeft aria-hidden="true" className="size-4" />
							{longDay(date)}
						</button>
						<RunDetails
							item={detail}
							onMessage={(agentId) => {
								setOpen(false);
								setDetail(null);
								handlers.onMessage(agentId);
							}}
							snapshot={handlers.snapshot}
						/>
					</div>
				) : (
					<div className="flex flex-col gap-2">
						{/* The reference's day card: weekday over the date, the date in
						    today's circle when it is today, the close button on its row. */}
						<div className="relative flex flex-col items-center gap-1 pt-1">
							<span className={cn(EYEBROW_CLASS, isToday && "text-primary")}>
								{weekdayShort(date)}
							</span>
							<span
								className={cn(
									"flex size-10 items-center justify-center rounded-full font-heading text-2xl tabular-nums leading-none",
									isToday
										? "bg-primary text-primary-foreground"
										: "text-foreground"
								)}
							>
								{date.getDate()}
							</span>
							<Button
								aria-label={`Close ${longDay(date)}`}
								className="absolute end-0 top-0"
								onClick={() => setOpen(false)}
								size="icon-sm"
								type="button"
								variant="ghost-muted"
							>
								<X aria-hidden="true" />
							</Button>
						</div>
						<ul
							aria-label={`Everything on ${longDay(date)}`}
							className="flex flex-col"
						>
							{items.map((item) => (
								<li key={item.key}>
									<AgendaRow
										active={
											item.kind === "thread" &&
											handlers.activeThreadId === item.thread.id
										}
										item={item}
										onChoose={() => {
											if (item.kind === "thread") {
												setOpen(false);
												handlers.onOpenThread(item.thread.id);
											} else {
												setDetail(item);
											}
										}}
										snapshot={handlers.snapshot}
									/>
								</li>
							))}
						</ul>
						{onOpenDay ? (
							<div className="flex justify-end border-border border-t pt-1.5">
								<Button
									onClick={() => {
										setOpen(false);
										onOpenDay(localDayKey(date));
									}}
									size="xs"
									type="button"
									variant="ghost"
								>
									Open week
									<ArrowRight aria-hidden="true" data-icon="inline-end" />
								</Button>
							</div>
						) : null}
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}

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
			triggerLabel={`${hiddenCount} more on ${longDay(date)}`}
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
					aria-label={`Show the week of ${longDay(date)}`}
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
