import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@ryu/ui/components/input-group.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { localDayKey } from "@ryuhq/protocol/interfaces";
import {
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Search,
	X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId } from "react";
import {
	countLabel,
	entryExcerpt,
	entryTitle,
	fullDateLabel,
	groupJournalMonths,
	type JournalEntry,
	monthLabel,
	monthWeeks,
	parseDayKey,
	timeLabel,
	weekdayNarrow,
	weekdayShort,
	weekOf,
} from "./journal-model.ts";
import { JournalEmpty, JournalStatusMark } from "./journal-parts.tsx";

export interface JournalTransition {
	duration: number;
	ease?: readonly [number, number, number, number];
}

/** Week strip that unfolds into the month, with a dot on days with entries. */
export function JournalStrip({
	days,
	expanded,
	onExpandedChange,
	onPage,
	onSelect,
	selectedDay,
	todayKey,
	transition,
}: {
	days: ReadonlyMap<string, JournalEntry[]>;
	expanded: boolean;
	onExpandedChange: (expanded: boolean) => void;
	onPage: (direction: -1 | 1) => void;
	onSelect: (key: string) => void;
	selectedDay: string;
	todayKey: string;
	transition: JournalTransition;
}) {
	const gridId = useId();
	const tl = useLiteralMessages();
	const weeks = expanded ? monthWeeks(selectedDay) : [weekOf(selectedDay)];
	const header = weeks[0] ?? [];
	return (
		<div className="px-3 pt-2 pb-3">
			<div className="flex h-8 items-center gap-1">
				<button
					aria-controls={gridId}
					aria-expanded={expanded}
					className="flex h-7 items-center gap-1 rounded-md px-2 font-medium text-muted-foreground text-sm outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
					onClick={() => onExpandedChange(!expanded)}
					type="button"
				>
					{monthLabel(selectedDay)}
					<ChevronDown
						aria-hidden="true"
						className={cn(
							"size-3.5 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
							expanded && "rotate-180"
						)}
					/>
					<span className="sr-only">
						{expanded ? "Show one week" : "Show the whole month"}
					</span>
				</button>
				<Button
					aria-label={expanded ? tl("Previous month") : tl("Previous week")}
					className="ms-auto"
					onClick={() => onPage(-1)}
					size="icon-xs"
					variant="ghost-muted"
				>
					<ChevronLeft aria-hidden="true" className="size-4" />
				</Button>
				<Button
					aria-label={expanded ? tl("Next month") : tl("Next week")}
					onClick={() => onPage(1)}
					size="icon-xs"
					variant="ghost-muted"
				>
					<ChevronRight aria-hidden="true" className="size-4" />
				</Button>
			</div>
			<div className="mt-1 grid grid-cols-7" id={gridId}>
				{header.map((date) => (
					<span
						aria-hidden="true"
						className="flex h-6 items-center justify-center font-medium text-muted-foreground text-xs"
						key={date.getDay()}
					>
						{weekdayNarrow(date)}
					</span>
				))}
			</div>
			<motion.div
				animate={{ height: "auto" }}
				className="overflow-hidden"
				initial={false}
				transition={transition}
			>
				<AnimatePresence initial={false} mode="popLayout">
					<motion.div
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						initial={{ opacity: 0 }}
						key={expanded ? "month" : "week"}
						transition={transition}
					>
						{weeks.map((week) => (
							<div
								className="grid grid-cols-7"
								key={localDayKey(week[0] ?? new Date())}
							>
								{week.map((date) => {
									const key = localDayKey(date);
									return (
										<StripDay
											count={days.get(key)?.length ?? 0}
											dayKey={key}
											dimmed={
												expanded &&
												date.getMonth() !== parseDayKey(selectedDay).getMonth()
											}
											key={key}
											onSelect={onSelect}
											selected={key === selectedDay}
											today={key === todayKey}
										/>
									);
								})}
							</div>
						))}
					</motion.div>
				</AnimatePresence>
			</motion.div>
		</div>
	);
}

function StripDay({
	count,
	dayKey,
	dimmed,
	onSelect,
	selected,
	today,
}: {
	count: number;
	dayKey: string;
	dimmed: boolean;
	onSelect: (key: string) => void;
	selected: boolean;
	today: boolean;
}) {
	const date = parseDayKey(dayKey);
	const label = `${fullDateLabel(dayKey)}${today ? ", today" : ""}, ${count === 0 ? "no entries" : countLabel(count, "entry", "entries")}`;
	return (
		<button
			aria-current={today ? "date" : undefined}
			aria-label={label}
			aria-pressed={selected}
			className="group flex h-10 flex-col items-center justify-center gap-0.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
			onClick={() => onSelect(dayKey)}
			type="button"
		>
			<span
				className={cn(
					"flex size-7 items-center justify-center rounded-full text-sm tabular-nums transition-colors",
					selected
						? "bg-foreground font-semibold text-background"
						: "group-hover:bg-muted",
					!selected && today && "font-semibold text-primary",
					!(selected || today) &&
						(dimmed ? "text-muted-foreground/60" : "text-foreground")
				)}
			>
				{date.getDate()}
			</span>
			<span
				aria-hidden="true"
				className={cn(
					"size-1 rounded-full",
					count > 0 ? "bg-primary" : "bg-transparent",
					count > 0 && dimmed && "bg-primary/40"
				)}
			/>
		</button>
	);
}

/** Search field for the timeline. Escape clears it. */
export function JournalSearch({
	onChange,
	query,
}: {
	onChange: (query: string) => void;
	query: string;
}) {
	const fieldId = useId();
	return (
		<div className="px-3 pb-2">
			<label className="sr-only" htmlFor={fieldId}>
				Search entries
			</label>
			<InputGroup className="h-8 rounded-lg border-transparent bg-muted/70 has-[[data-slot=input-group-control]:focus-visible]:bg-background">
				<InputGroupAddon className="ps-2.5">
					<Search aria-hidden="true" className="size-4" />
				</InputGroupAddon>
				<InputGroupInput
					autoComplete="off"
					className="h-full text-sm [&::-webkit-search-cancel-button]:appearance-none"
					id={fieldId}
					onChange={(event) => onChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape" && query) {
							event.preventDefault();
							event.stopPropagation();
							onChange("");
						}
					}}
					placeholder="Search"
					type="search"
					value={query}
				/>
				{query ? (
					<InputGroupAddon align="inline-end">
						<InputGroupButton
							aria-label="Clear search"
							onClick={() => onChange("")}
							size="icon-xs"
						>
							<X aria-hidden="true" className="size-3.5" />
						</InputGroupButton>
					</InputGroupAddon>
				) : null}
			</InputGroup>
		</div>
	);
}

/** The timeline: month headers, then each day's entries newest first. */
export function JournalTimeline({
	activeThreadId,
	entries,
	loading,
	onNewEntry,
	onOpen,
	query,
	selectedDay,
	titleClass,
}: {
	activeThreadId: string | null;
	entries: JournalEntry[];
	loading: boolean;
	onNewEntry: () => void;
	onOpen: (entry: JournalEntry) => void;
	query: string;
	selectedDay: string | null;
	titleClass: string;
}) {
	const tl = useLiteralMessages();
	if (loading) {
		return <TimelineSkeleton />;
	}
	if (entries.length === 0) {
		return query.trim() ? (
			<JournalEmpty
				description="Try a title, a phrase from a message, or an agent's name."
				title={tl('No entries match "{query}"', { query: query.trim() })}
			/>
		) : (
			<JournalEmpty
				action={
					<Button onClick={onNewEntry} size="sm" variant="outline">
						New entry
					</Button>
				}
				description="Each conversation becomes an entry on the day it was last active."
				title="No entries yet"
			/>
		);
	}
	const months = groupJournalMonths(entries);
	return (
		<nav aria-label="Entries" className="pb-6">
			<p aria-live="polite" className="sr-only">
				{query.trim() ? countLabel(entries.length, "result") : ""}
			</p>
			{months.map((month) => (
				<section aria-label={month.label} key={month.key}>
					<h3 className="sticky top-0 z-10 flex h-8 items-center justify-between bg-background px-4 font-semibold text-foreground text-xs">
						{month.label}
						<span className="font-normal text-muted-foreground tabular-nums">
							{month.days.reduce((sum, day) => sum + day.entries.length, 0)}
						</span>
					</h3>
					<ol>
						{month.days.map((day) => (
							<li
								className="mx-2 grid scroll-mt-8 grid-cols-[3.5rem_minmax(0,1fr)] border-border/70 border-b py-1 last:border-b-0"
								data-day={day.key}
								data-selected={day.key === selectedDay || undefined}
								key={day.key}
							>
								<DayGutter
									dayKey={day.key}
									selected={day.key === selectedDay}
								/>
								<ol className="col-start-2 row-start-1 -ms-14">
									{day.entries.map((entry) => (
										<li key={entry.thread.id}>
											<TimelineRow
												active={entry.thread.id === activeThreadId}
												entry={entry}
												onOpen={onOpen}
												titleClass={titleClass}
											/>
										</li>
									))}
								</ol>
							</li>
						))}
					</ol>
				</section>
			))}
		</nav>
	);
}

/**
 * The day's weekday and date. It sticks under the month header while the
 * day's rows scroll past, so every row keeps its date in view.
 */
function DayGutter({
	dayKey,
	selected,
}: {
	dayKey: string;
	selected: boolean;
}) {
	return (
		<span
			aria-hidden="true"
			className="pointer-events-none sticky top-8 z-[1] col-start-1 row-start-1 flex flex-col items-center self-start ps-2 pe-3 pt-3 pb-1"
		>
			<span
				className={cn(
					"font-medium text-[11px] uppercase leading-4 tracking-wide",
					selected ? "text-primary" : "text-muted-foreground"
				)}
			>
				{weekdayShort(dayKey)}
			</span>
			<span
				className={cn(
					"font-semibold text-xl tabular-nums leading-6",
					selected ? "text-primary" : "text-foreground"
				)}
			>
				{parseDayKey(dayKey).getDate()}
			</span>
		</span>
	);
}

function TimelineRow({
	active,
	entry,
	onOpen,
	titleClass,
}: {
	active: boolean;
	entry: JournalEntry;
	onOpen: (entry: JournalEntry) => void;
	titleClass: string;
}) {
	const lead = entry.agents[0];
	return (
		<button
			aria-current={active ? "page" : undefined}
			className={cn(
				"flex w-full rounded-lg py-2.5 ps-14 pe-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
				active ? "bg-muted" : "hover:bg-muted/60"
			)}
			data-thread-id={entry.thread.id}
			onClick={() => onOpen(entry)}
			type="button"
		>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="flex items-center gap-2">
					<span
						className={cn(
							"truncate font-semibold text-base leading-6",
							titleClass
						)}
					>
						{entryTitle(entry.thread)}
					</span>
					<JournalStatusMark
						className="ms-auto shrink-0"
						status={entry.status}
					/>
				</span>
				<span className="mt-0.5 line-clamp-2 text-muted-foreground text-sm leading-5">
					{entryExcerpt(entry.thread)}
				</span>
				<span className="mt-1.5 flex items-center gap-1.5 text-muted-foreground text-xs leading-4">
					<time className="tabular-nums" dateTime={entry.thread.updatedAt}>
						{timeLabel(entry.at)}
					</time>
					<span aria-hidden="true">·</span>
					<span className="truncate">
						{lead ? lead.name : "No agent"}
						{entry.agents.length > 1 ? ` +${entry.agents.length - 1}` : ""}
					</span>
				</span>
			</span>
		</button>
	);
}

const SKELETON_ROWS = ["a", "b", "c", "d", "e"] as const;

function TimelineSkeleton() {
	return (
		<div
			aria-busy="true"
			aria-label="Loading entries"
			className="px-4 pt-3"
			role="status"
		>
			<Skeleton className="mb-4 h-3 w-24" radius="dense" />
			{SKELETON_ROWS.map((row) => (
				<div className="mb-5 grid grid-cols-[2.25rem_1fr] gap-x-3" key={row}>
					<div className="flex flex-col items-center gap-1">
						<Skeleton className="h-2.5 w-6" radius="dense" />
						<Skeleton className="h-5 w-5" radius="dense" />
					</div>
					<div className="flex flex-col gap-1.5">
						<Skeleton className="h-3.5 w-3/4" radius="dense" />
						<Skeleton className="h-3 w-full" radius="dense" />
						<Skeleton className="h-3 w-2/3" radius="dense" />
					</div>
				</div>
			))}
		</div>
	);
}

/** "Today", "Yesterday", or the weekday and date. */
export function relativeDayName(key: string, todayKey: string): string {
	if (key === todayKey) {
		return "Today";
	}
	const yesterday = new Date(parseDayKey(todayKey));
	yesterday.setDate(yesterday.getDate() - 1);
	if (key === localDayKey(yesterday)) {
		return "Yesterday";
	}
	return weekdayShort(key);
}
