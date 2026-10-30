import { useLiteralMessages } from "@ryu/i18n/react";
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
import { type CSSProperties, type ReactNode, useState } from "react";
import {
	type CalendarItem,
	compactTime,
	isAggregate,
	longDay,
	type RunItem,
	weekdayShort,
} from "./calendar-model.ts";
import {
	ACTIVE_ITEM_CLASS,
	CALENDAR_ITEM_ATTRIBUTE,
	ChipBody,
	chipClassName,
	EYEBROW_CLASS,
	ItemMark,
	itemAccessibleName,
	RunDetails,
	RunPopover,
	threadTitle,
} from "./calendar-parts.tsx";

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
	const tl = useLiteralMessages();
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
								aria-label={tl("Close {day}", { day: longDay(date) })}
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
							aria-label={tl("Everything on {day}", { day: longDay(date) })}
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
