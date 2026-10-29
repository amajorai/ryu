import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	localDayKey,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
} from "@ryuhq/protocol/interfaces";
import { Check, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useId, useState } from "react";
import {
	addDays,
	addMonths,
	type CalendarLayer,
	type CalendarScale,
	compactTime,
	longDay,
	monthGridDays,
	parseDayKey,
	type RunItem,
	rangeTitle,
	relativeDay,
	sameMonth,
	startOfWeek,
	statusCounts,
	weekdayNames,
} from "./calendar-model.ts";
import {
	CALENDAR_DAY_ATTRIBUTE,
	ITEM_RADIUS_CLASS,
	MICRO_TEXT_CLASS,
	RunPopover,
} from "./calendar-parts.tsx";
import { agentById } from "./interface-renderer.ts";

function RailHeading({ children, id }: { children: string; id: string }) {
	return (
		<h2 className="px-2 font-medium text-foreground text-sm leading-5" id={id}>
			{children}
		</h2>
	);
}

/**
 * The rail's month picker. It browses months on its own; picking a day moves
 * the main view there. Days with anything on them carry a dot.
 */
function MiniMonth({
	activeDayKeys,
	displayKey,
	onDisplayChange,
	onSelectDay,
	scale,
	selectedKey,
	todayKey,
}: {
	activeDayKeys: ReadonlySet<string>;
	displayKey: string;
	onDisplayChange: (key: string) => void;
	onSelectDay: (key: string) => void;
	scale: CalendarScale;
	selectedKey: string;
	todayKey: string;
}) {
	const display = parseDayKey(displayKey);
	const days = monthGridDays(display);
	const names = weekdayNames();
	const selected = parseDayKey(selectedKey);
	const weekStart = localDayKey(startOfWeek(selected));
	const weekEnd = localDayKey(addDays(startOfWeek(selected), 6));
	const tabKey = days.some((day) => localDayKey(day) === selectedKey)
		? selectedKey
		: localDayKey(new Date(display.getFullYear(), display.getMonth(), 1));
	const weeks: Date[][] = [];
	for (let index = 0; index < days.length; index += 7) {
		weeks.push(days.slice(index, index + 7));
	}
	return (
		<section aria-label="Month picker" className="flex flex-col gap-1">
			<div className="flex items-center gap-1 ps-2">
				<p
					aria-live="polite"
					className="flex-1 truncate font-medium text-foreground text-sm"
				>
					{rangeTitle("month", display)}
				</p>
				<Button
					aria-label="Previous month in picker"
					onClick={() => onDisplayChange(localDayKey(addMonths(display, -1)))}
					size="icon-xs"
					type="button"
					variant="ghost-muted"
				>
					<ChevronLeft aria-hidden="true" />
				</Button>
				<Button
					aria-label="Next month in picker"
					onClick={() => onDisplayChange(localDayKey(addMonths(display, 1)))}
					size="icon-xs"
					type="button"
					variant="ghost-muted"
				>
					<ChevronRight aria-hidden="true" />
				</Button>
			</div>
			<div
				aria-label={rangeTitle("month", display)}
				className="flex flex-col"
				data-calendar-zone="mini"
				role="grid"
			>
				<div className="grid grid-cols-7 px-1" role="row">
					{names.map((name) => (
						<span
							className={cn(
								"flex h-6 items-center justify-center font-medium text-muted-foreground",
								MICRO_TEXT_CLASS
							)}
							key={name.short}
							role="columnheader"
						>
							<abbr className="no-underline" title={name.short}>
								{name.narrow}
							</abbr>
						</span>
					))}
				</div>
				{weeks.map((week) => (
					<div
						className="grid grid-cols-7 px-1"
						key={localDayKey(week[0] ?? display)}
						role="row"
					>
						{week.map((date) => {
							const key = localDayKey(date);
							const isToday = key === todayKey;
							const isSelected = key === selectedKey;
							const inWeek =
								scale === "week" && key >= weekStart && key <= weekEnd;
							const inMonth = sameMonth(date, display);
							return (
								<span
									className={cn(
										"flex justify-center py-px",
										inWeek &&
											"bg-primary/10 first:rounded-s-full last:rounded-e-full"
									)}
									key={key}
									role="gridcell"
								>
									<button
										{...{ [CALENDAR_DAY_ATTRIBUTE]: key }}
										aria-current={isToday ? "date" : undefined}
										aria-label={`${longDay(date)}${isToday ? ", today" : ""}${activeDayKeys.has(key) ? ", has items" : ""}`}
										aria-pressed={isSelected}
										className={cn(
											"relative flex size-7 items-center justify-center rounded-full text-xs tabular-nums outline-none transition-colors",
											"hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
											inMonth ? "text-foreground" : "text-muted-foreground",
											isSelected &&
												!isToday &&
												"bg-primary/15 font-semibold text-foreground",
											isToday &&
												"bg-primary font-semibold text-primary-foreground hover:bg-primary/90"
										)}
										data-day-key={key}
										onClick={() => onSelectDay(key)}
										tabIndex={key === tabKey ? 0 : -1}
										type="button"
									>
										{date.getDate()}
										{activeDayKeys.has(key) && !isToday ? (
											<span
												aria-hidden="true"
												className="absolute bottom-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-muted-foreground"
											/>
										) : null}
									</button>
								</span>
							);
						})}
					</div>
				))}
			</div>
		</section>
	);
}

function UpcomingRuns({
	now,
	onMessage,
	runs,
	snapshot,
}: {
	now: Date;
	onMessage: (agentId: string) => void;
	runs: readonly RunItem[];
	snapshot: InterfaceSnapshot;
}) {
	const [openKey, setOpenKey] = useState<string | null>(null);
	const headingId = useId();
	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-1">
			<RailHeading id={headingId}>Upcoming runs</RailHeading>
			{runs.length === 0 ? (
				<p className="px-2 py-1 text-muted-foreground text-xs">
					{snapshot.events === undefined
						? "No schedules on this host."
						: "Nothing scheduled."}
				</p>
			) : (
				<ul className="flex flex-col">
					{runs.map((run) => {
						const agent = agentById(snapshot, run.event.agentId);
						// An aggregate's start only stands in for its day: name its schedule.
						const when =
							(run.event.count ?? 0) > 1
								? (run.event.label ?? "All day")
								: compactTime(run.start);
						return (
							<li key={run.key}>
								<RunPopover
									className={cn(
										"group/run flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left outline-none transition-colors",
										"hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted"
									)}
									item={run}
									onMessage={onMessage}
									onOpenChange={(open) => setOpenKey(open ? run.key : null)}
									open={openKey === run.key}
									snapshot={snapshot}
									tabStop
								>
									<span className="w-full truncate text-foreground text-sm leading-5">
										{run.event.title}
									</span>
									<span className="w-full truncate text-muted-foreground text-xs tabular-nums leading-4">
										{relativeDay(run.start, now)} · {when}
										{agent ? ` · ${agent.name}` : ""}
									</span>
								</RunPopover>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}

const LAYERS: readonly CalendarLayer[] = [...THREAD_STATUS_ORDER, "runs"];

function layerLabel(layer: CalendarLayer): string {
	return layer === "runs" ? "Scheduled runs" : THREAD_STATUS_LABELS[layer];
}

/**
 * Each layer's checkbox, like a calendar's list of calendars: the box is
 * drawn in the tone its items are drawn in, quietly (a tinted box with a
 * coloured check), the same tone as the dot its items carry.
 */
const LAYER_BOX: Record<CalendarLayer, string> = {
	attention: "border-destructive bg-destructive/12 text-status-destructive",
	quiet:
		"border-muted-foreground/70 bg-muted-foreground/8 text-muted-foreground",
	runs: "border-muted-foreground/70 bg-muted-foreground/8 text-muted-foreground",
	waiting:
		"border-muted-foreground/70 bg-muted-foreground/8 text-muted-foreground",
	working: "border-success bg-success/12 text-status-success",
	"your-turn": "border-foreground bg-foreground/8 text-foreground",
};

/** Show or hide each status (and runs), like a calendar's own list. */
function LayerList({
	counts,
	hidden,
	onToggle,
}: {
	counts: Record<CalendarLayer, number>;
	hidden: ReadonlySet<CalendarLayer>;
	onToggle: (layer: CalendarLayer) => void;
}) {
	const headingId = useId();
	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-1">
			<RailHeading id={headingId}>Show</RailHeading>
			<ul className="flex flex-col">
				{LAYERS.map((layer) => {
					const visible = !hidden.has(layer);
					return (
						<li key={layer}>
							<button
								aria-checked={visible}
								className="flex h-8 w-full items-center gap-2 rounded-md ps-2 pe-1 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
								onClick={() => onToggle(layer)}
								role="checkbox"
								type="button"
							>
								<span
									aria-hidden="true"
									className={cn(
										"flex size-4 shrink-0 items-center justify-center border-[1.5px] transition-colors",
										ITEM_RADIUS_CLASS,
										LAYER_BOX[layer],
										!visible && "bg-transparent"
									)}
								>
									{visible ? (
										<Check className="size-3" strokeWidth={2.5} />
									) : null}
								</span>
								<span className="flex-1 truncate text-foreground">
									{layerLabel(layer)}
								</span>
								<span className="min-w-4 text-end text-muted-foreground text-xs tabular-nums">
									{counts[layer]}
								</span>
							</button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/**
 * The left rail: a new-thread action, the month picker, the next scheduled
 * runs, and the layer list.
 */
export function CalendarRail({
	activeDayKeys,
	className,
	hidden,
	miniKey,
	now,
	onMessage,
	onMiniChange,
	onNewThread,
	onSelectDay,
	onToggleLayer,
	runs,
	scale,
	selectedKey,
	snapshot,
	todayKey,
}: {
	activeDayKeys: ReadonlySet<string>;
	className?: string;
	hidden: ReadonlySet<CalendarLayer>;
	miniKey: string;
	now: Date;
	onMessage: (agentId: string) => void;
	onMiniChange: (key: string) => void;
	/** Start a thread; null when there is no agent to start one with. */
	onNewThread: (() => void) | null;
	onSelectDay: (key: string) => void;
	onToggleLayer: (layer: CalendarLayer) => void;
	runs: readonly RunItem[];
	scale: CalendarScale;
	selectedKey: string;
	snapshot: InterfaceSnapshot;
	todayKey: string;
}) {
	const counts: Record<CalendarLayer, number> = {
		...statusCounts(snapshot.threads),
		runs: snapshot.events?.length ?? 0,
	};
	return (
		<aside
			aria-label="Calendar sidebar"
			className={cn(
				"w-56 shrink-0 flex-col gap-5 overflow-y-auto px-3 pt-3 pb-6 xl:w-64",
				className
			)}
			data-testid="calendar-rail"
		>
			{onNewThread ? (
				<Button
					className="w-fit self-start rounded-lg"
					data-calendar-rail-start=""
					onClick={onNewThread}
					type="button"
					variant="outline"
				>
					<Plus aria-hidden="true" data-icon="inline-start" />
					New thread
				</Button>
			) : null}
			<MiniMonth
				activeDayKeys={activeDayKeys}
				displayKey={miniKey}
				onDisplayChange={onMiniChange}
				onSelectDay={onSelectDay}
				scale={scale}
				selectedKey={selectedKey}
				todayKey={todayKey}
			/>
			<UpcomingRuns
				now={now}
				onMessage={onMessage}
				runs={runs}
				snapshot={snapshot}
			/>
			<LayerList counts={counts} hidden={hidden} onToggle={onToggleLayer} />
		</aside>
	);
}
