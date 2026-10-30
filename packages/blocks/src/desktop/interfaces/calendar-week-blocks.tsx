import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties } from "react";
import {
	CASCADE_MINUTES,
	type CalendarItem,
	compactTime,
	HOUR_PX,
	longDay,
	MIN_BLOCK_PX,
	minuteOfDay,
	type PlacedItem,
	type WeekFold,
} from "./calendar-model.ts";
import {
	type CalendarItemHandlers,
	DayAgendaPopover,
} from "./calendar-month.tsx";
import {
	BlockAccent,
	blockToneClass,
	CALENDAR_ITEM_ATTRIBUTE,
	ITEM_RADIUS_CLASS,
	itemAccessibleName,
	RunPopover,
	threadTitle,
} from "./calendar-parts.tsx";

/** Blocks shorter than this show one line: "Title, 9:16am". */
const TWO_LINE_PX = 34;
/** Blocks at least this tall give the title two lines before the time. */
const TALL_TITLE_PX = 52;

/** Gap between blocks that follow one another, or sit side by side. */
const BLOCK_GAP_PX = 2;

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

export function WeekBlock({
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
export function NowLine({ now, today }: { now: Date; today: boolean }) {
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
export function FoldButton({
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
	const tl = useLiteralMessages();
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
			triggerLabel={tl("{count} more at {time} on {day}", {
				count,
				day: longDay(date),
				time: compactTime(fold.items[0]?.start ?? date),
			})}
		>
			+{count}
		</DayAgendaPopover>
	);
}
