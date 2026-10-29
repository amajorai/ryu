import { cn } from "@ryu/ui/lib/utils";
import { localDayKey } from "@ryuhq/protocol/interfaces";
import { type KeyboardEvent, useState } from "react";
import {
	countLabel,
	entryTitle,
	fullDateLabel,
	type HeatCell,
	type HeatColumn,
	type JournalEntry,
	type JournalStats,
	monthLabel,
	monthWeeks,
	parseDayKey,
	weekdayNarrow,
	weekdayShort,
	yearHeatmap,
} from "./journal-model.ts";
import { JournalFaces, JournalStatusMark } from "./journal-parts.tsx";

/** The wide column the Calendar and Stats pages share. */
export const WIDE_COLUMN = "mx-auto w-full max-w-[64rem] px-6 sm:px-10";

const CELL_TITLES = 2;
/** Narrow cells trade titles for one status dot per entry. */
const DOT_LIMIT = 6;

/** Arrow-key steps in days across the month grid. */
const CALENDAR_STEP: Record<string, number> = {
	ArrowDown: 7,
	ArrowLeft: -1,
	ArrowRight: 1,
	ArrowUp: -7,
};

/** Day One's calendar: the month as a grid, each day showing what it holds. */
export function JournalCalendar({
	byDay,
	monthKey,
	onSelectDay,
	selectedDay,
	titleClass,
	todayKey,
}: {
	byDay: ReadonlyMap<string, JournalEntry[]>;
	/** Any day inside the month to show. */
	monthKey: string;
	onSelectDay: (key: string) => void;
	selectedDay: string;
	titleClass: string;
	todayKey: string;
}) {
	const weeks = monthWeeks(monthKey);
	const month = parseDayKey(monthKey).getMonth();
	const keys = weeks.flat().map((date) => localDayKey(date));
	const [focusKey, setFocusKey] = useState(selectedDay);
	let activeKey = keys[0] ?? "";
	if (keys.includes(focusKey)) {
		activeKey = focusKey;
	} else if (keys.includes(selectedDay)) {
		activeKey = selectedDay;
	}

	// One tab stop for the month; arrows move by day and week, Home and End
	// to the ends of the week, Enter opens the day.
	const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const index = keys.indexOf(activeKey);
		let next: number;
		if (event.key in CALENDAR_STEP) {
			next = index + (CALENDAR_STEP[event.key] ?? 0);
		} else if (event.key === "Home") {
			next = index - (index % 7);
		} else if (event.key === "End") {
			next = index - (index % 7) + 6;
		} else {
			return;
		}
		event.preventDefault();
		const key = keys[Math.min(Math.max(next, 0), keys.length - 1)];
		if (!key) {
			return;
		}
		setFocusKey(key);
		const target = event.currentTarget.querySelector(`[data-day="${key}"]`);
		if (target instanceof HTMLElement) {
			target.focus();
		}
	};

	let total = 0;
	for (const week of weeks) {
		for (const date of week) {
			if (date.getMonth() === month) {
				total += byDay.get(localDayKey(date))?.length ?? 0;
			}
		}
	}
	return (
		<div className={cn(WIDE_COLUMN, "pt-10 pb-16")}>
			<header className="pb-5">
				<h1
					className={cn(
						"truncate font-semibold text-3xl text-foreground leading-10",
						titleClass
					)}
				>
					{monthLabel(monthKey)}
				</h1>
				<p className="text-muted-foreground text-sm leading-5">
					{total === 0
						? "No entries this month"
						: countLabel(total, "entry", "entries")}
				</p>
			</header>
			<div
				aria-label={monthLabel(monthKey)}
				className="border-border border-t"
				onKeyDown={onGridKeyDown}
				role="grid"
			>
				<div className="grid grid-cols-7 border-border border-b" role="row">
					{(weeks[0] ?? []).map((date) => (
						<span
							className="px-3 py-2 font-medium text-muted-foreground text-xs"
							key={date.getDay()}
							role="columnheader"
						>
							<span className="max-sm:hidden">
								{weekdayShort(localDayKey(date))}
							</span>
							<span className="sm:hidden">{weekdayNarrow(date)}</span>
						</span>
					))}
				</div>
				{weeks.map((week) => (
					<div
						className="grid grid-cols-7 border-border border-b"
						key={localDayKey(week[0] ?? new Date())}
						role="row"
					>
						{week.map((date) => {
							const key = localDayKey(date);
							return (
								<CalendarCell
									dayKey={key}
									entries={byDay.get(key) ?? []}
									inMonth={date.getMonth() === month}
									key={key}
									onFocusDay={setFocusKey}
									onSelectDay={onSelectDay}
									selected={key === selectedDay}
									tabbable={key === activeKey}
									today={key === todayKey}
								/>
							);
						})}
					</div>
				))}
			</div>
		</div>
	);
}

function CalendarCell({
	dayKey,
	entries,
	inMonth,
	onFocusDay,
	onSelectDay,
	selected,
	tabbable,
	today,
}: {
	dayKey: string;
	entries: JournalEntry[];
	inMonth: boolean;
	onFocusDay: (key: string) => void;
	onSelectDay: (key: string) => void;
	selected: boolean;
	tabbable: boolean;
	today: boolean;
}) {
	const shown = entries.slice(0, CELL_TITLES);
	const more = entries.length - shown.length;
	const label = `${fullDateLabel(dayKey)}, ${
		entries.length === 0
			? "no entries"
			: countLabel(entries.length, "entry", "entries")
	}`;
	return (
		<div
			className="@container min-w-0 border-border border-e last:border-e-0"
			role="gridcell"
		>
			<button
				aria-current={today ? "date" : undefined}
				aria-label={label}
				aria-pressed={selected}
				className={cn(
					"flex h-28 w-full flex-col gap-1 p-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset max-md:h-20",
					selected && !today ? "bg-muted" : "hover:bg-muted/50"
				)}
				data-day={dayKey}
				onClick={() => onSelectDay(dayKey)}
				onFocus={() => onFocusDay(dayKey)}
				tabIndex={tabbable ? 0 : -1}
				type="button"
			>
				<span className="flex h-6 items-center justify-between gap-1">
					<span
						className={cn(
							"flex size-6 items-center justify-center rounded-full text-sm tabular-nums",
							today
								? "bg-primary font-semibold text-primary-foreground"
								: inMonth
									? "text-foreground"
									: "text-muted-foreground/60"
						)}
					>
						{parseDayKey(dayKey).getDate()}
					</span>
					{entries.length > 0 ? (
						<span className="pe-1 text-muted-foreground text-xs tabular-nums">
							{entries.length}
						</span>
					) : null}
				</span>
				<span
					aria-hidden="true"
					className="flex @max-[7rem]:hidden min-w-0 flex-col gap-0.5 max-md:hidden"
				>
					{shown.map((entry) => (
						<span
							className="flex min-w-0 items-center gap-1.5 text-foreground text-xs leading-5"
							key={entry.thread.id}
						>
							<JournalStatusMark className="shrink-0" status={entry.status} />
							<span className="truncate">{entryTitle(entry.thread)}</span>
						</span>
					))}
					{more > 0 ? (
						<span className="ps-3.5 text-muted-foreground text-xs leading-5">
							{more} more
						</span>
					) : null}
				</span>
				{entries.length > 0 ? (
					<span
						aria-hidden="true"
						className="@max-[7rem]:flex hidden flex-wrap gap-1 ps-1 max-md:flex"
					>
						{entries.slice(0, DOT_LIMIT).map((entry) => (
							<JournalStatusMark key={entry.thread.id} status={entry.status} />
						))}
					</span>
				) : null}
			</button>
		</div>
	);
}

const HEAT_LEVEL: Record<HeatCell["level"], string> = {
	0: "bg-muted",
	1: "bg-primary/35",
	2: "bg-primary/55",
	3: "bg-primary/75",
	4: "bg-primary",
};

const HEAT_WEEKDAY_ROWS = new Set([1, 3, 5]);
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

function heatCellLabel(cell: HeatCell): string {
	return `${fullDateLabel(cell.key)}, ${
		cell.count === 0 ? "no entries" : countLabel(cell.count, "entry", "entries")
	}`;
}

/** Arrow-key steps in days: columns are weeks, rows are weekdays. */
const HEAT_STEP: Record<string, number> = {
	ArrowDown: 1,
	ArrowLeft: -7,
	ArrowRight: 7,
	ArrowUp: -1,
};

/**
 * A year of activity as one tab stop: Tab lands on the focused day, arrows
 * move by day and week, Home and End jump to the ends, Enter opens the day.
 */
function YearHeatmap({
	columns,
	onSelectDay,
	todayKey,
}: {
	columns: HeatColumn[];
	onSelectDay: (key: string) => void;
	todayKey: string;
}) {
	const cells = columns.flatMap((column) => column.cells);
	const keys = cells.filter((cell) => !cell.future).map((cell) => cell.key);
	const [focusKey, setFocusKey] = useState(todayKey);
	const activeKey = keys.includes(focusKey) ? focusKey : (keys.at(-1) ?? "");

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const index = keys.indexOf(activeKey);
		let next = -1;
		if (event.key in HEAT_STEP) {
			next = index + (HEAT_STEP[event.key] ?? 0);
		} else if (event.key === "Home") {
			next = 0;
		} else if (event.key === "End") {
			next = keys.length - 1;
		} else {
			return;
		}
		event.preventDefault();
		const key = keys[Math.min(Math.max(next, 0), keys.length - 1)];
		if (!key) {
			return;
		}
		setFocusKey(key);
		const target = event.currentTarget.querySelector(`[data-day="${key}"]`);
		if (target instanceof HTMLElement) {
			target.focus();
		}
	};

	return (
		<div className="mt-3 overflow-x-auto pb-1">
			<div className="flex min-w-[42rem] gap-[3px]">
				<div
					aria-hidden="true"
					className="grid shrink-0 grid-rows-[1rem_repeat(7,minmax(0,1fr))] gap-[3px] pe-1"
				>
					<span />
					{WEEKDAYS.map((weekday) => (
						<span
							className="flex items-center text-muted-foreground text-xs leading-3"
							key={weekday}
						>
							{HEAT_WEEKDAY_ROWS.has(weekday)
								? weekdayShort(localDayKey(new Date(2026, 0, 4 + weekday)))
								: ""}
						</span>
					))}
				</div>
				<div
					aria-label="Activity by day, last 12 months"
					aria-roledescription="heatmap"
					className="flex min-w-0 flex-1 gap-[3px]"
					onKeyDown={onKeyDown}
					role="group"
				>
					{columns.map((column) => (
						<div
							className="grid min-w-0 flex-1 grid-rows-[1rem_repeat(7,auto)] gap-[3px]"
							key={column.cells[0]?.key}
						>
							<span
								aria-hidden="true"
								className="w-0 overflow-visible whitespace-nowrap text-muted-foreground text-xs leading-3"
							>
								{column.month ?? ""}
							</span>
							{column.cells.map((cell) =>
								cell.future ? (
									<span
										aria-hidden="true"
										className="aspect-square w-full"
										key={cell.key}
									/>
								) : (
									<button
										aria-label={heatCellLabel(cell)}
										className={cn(
											"aspect-square w-full rounded-[3px] outline-none transition-shadow hover:ring-1 hover:ring-foreground/40 focus-visible:ring-2 focus-visible:ring-ring",
											HEAT_LEVEL[cell.level]
										)}
										data-day={cell.key}
										key={cell.key}
										onClick={() => onSelectDay(cell.key)}
										onFocus={() => setFocusKey(cell.key)}
										tabIndex={cell.key === activeKey ? 0 : -1}
										title={heatCellLabel(cell)}
										type="button"
									/>
								)
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

/** Day One's stats: the counts, a year of activity, and who wrote it. */
export function JournalStatsPage({
	byDay,
	onSelectDay,
	stats,
	titleClass,
	today,
}: {
	byDay: ReadonlyMap<string, JournalEntry[]>;
	onSelectDay: (key: string) => void;
	stats: JournalStats;
	titleClass: string;
	today: Date;
}) {
	const columns = yearHeatmap(byDay, today);
	const figures: { label: string; unit?: string; value: number }[] = [
		{ label: "Entries", value: stats.entries },
		{ label: "Days journaled", value: stats.daysJournaled },
		{ label: "Messages", value: stats.messages },
		{
			label: "Current streak",
			unit: stats.currentStreak === 1 ? "day" : "days",
			value: stats.currentStreak,
		},
		{
			label: "Longest streak",
			unit: stats.longestStreak === 1 ? "day" : "days",
			value: stats.longestStreak,
		},
	];
	const topEntries = stats.agents[0]?.entries ?? 0;
	return (
		<div className={cn(WIDE_COLUMN, "pt-10 pb-16")}>
			<header className="pb-8">
				<h1
					className={cn(
						"font-semibold text-3xl text-foreground leading-10",
						titleClass
					)}
				>
					Stats
				</h1>
				<p className="text-muted-foreground text-sm leading-5">
					{countLabel(stats.thisYear, "entry", "entries")} in the last year
				</p>
			</header>
			<dl className="grid grid-cols-5 gap-x-8 gap-y-5 border-border border-y py-6 max-sm:grid-cols-2 max-md:grid-cols-3">
				{figures.map((figure) => (
					<div className="flex flex-col-reverse gap-1" key={figure.label}>
						<dt className="text-muted-foreground text-sm leading-5">
							{figure.label}
						</dt>
						<dd className="flex items-baseline gap-1.5">
							<span
								className={cn(
									"font-semibold text-3xl text-foreground tabular-nums leading-9",
									titleClass
								)}
							>
								{figure.value.toLocaleString()}
							</span>
							{figure.unit ? (
								<span className="text-muted-foreground text-sm">
									{figure.unit}
								</span>
							) : null}
						</dd>
					</div>
				))}
			</dl>

			<section aria-labelledby="journal-stats-year" className="mt-10">
				<h2
					className="font-semibold text-foreground text-sm leading-5"
					id="journal-stats-year"
				>
					Activity
				</h2>
				<YearHeatmap
					columns={columns}
					onSelectDay={onSelectDay}
					todayKey={localDayKey(today)}
				/>
				<div
					aria-hidden="true"
					className="mt-2 flex items-center justify-end gap-1 text-muted-foreground text-xs"
				>
					<span className="me-1">Less</span>
					{([0, 1, 2, 3, 4] as const).map((level) => (
						<span
							className={cn("size-3 rounded-[3px]", HEAT_LEVEL[level])}
							key={level}
						/>
					))}
					<span className="ms-1">More</span>
				</div>
			</section>

			{stats.agents.length > 0 ? (
				<section aria-labelledby="journal-stats-agents" className="mt-10">
					<h2
						className="font-semibold text-foreground text-sm leading-5"
						id="journal-stats-agents"
					>
						Agents
					</h2>
					<table className="mt-2 w-full text-sm">
						<thead className="sr-only">
							<tr>
								<th scope="col">Agent</th>
								<th scope="col">Share</th>
								<th scope="col">Entries</th>
								<th scope="col">Messages</th>
							</tr>
						</thead>
						<tbody>
							{stats.agents.map((share) => (
								<tr
									className="border-border border-b last:border-b-0"
									key={share.agent.id}
								>
									<th
										className="w-48 py-2.5 pe-4 text-left font-normal max-sm:w-32"
										scope="row"
									>
										<span className="flex items-center gap-2.5">
											<JournalFaces agents={[share.agent]} />
											<span className="truncate text-foreground">
												{share.agent.name}
											</span>
										</span>
									</th>
									<td aria-hidden="true" className="py-2.5 pe-4 max-sm:hidden">
										<span className="block h-1.5 w-full rounded-full bg-muted">
											<span
												className="block h-full rounded-full bg-primary/70"
												style={{
													width: `${topEntries > 0 ? (share.entries / topEntries) * 100 : 0}%`,
												}}
											/>
										</span>
									</td>
									<td className="w-24 py-2.5 text-right text-foreground tabular-nums">
										{share.entries.toLocaleString()}
										<span className="text-muted-foreground">
											{share.entries === 1 ? " entry" : " entries"}
										</span>
									</td>
									<td className="w-32 py-2.5 text-right text-foreground tabular-nums">
										{share.messages.toLocaleString()}
										<span className="text-muted-foreground">
											{share.messages === 1 ? " message" : " messages"}
										</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			) : null}
		</div>
	);
}
