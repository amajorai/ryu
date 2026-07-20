import type { ReactNode } from "react";

/**
 * Presentational, SSR-safe GitHub-style contributions heatmap.
 *
 * Renders a fixed 53-week x 7-day grid of cells bucketed by intensity, with
 * month labels, weekday labels, a per-cell tooltip and a legend. Pure: no data
 * fetching, no effects, no access to `window`/`document`. The calendar window is
 * derived from the data itself (latest `day`) so server and client render the
 * same markup; it only falls back to the current date when `data` is empty.
 */

export interface ContributionDay {
	count: number;
	day: string;
}

export interface ContributionsGraphProps {
	data: ContributionDay[];
	/** Number of filled intensity buckets (excludes the empty bucket). */
	levels?: number;
	title?: string;
}

const WEEKS = 53;
const DAYS_IN_WEEK = 7;
const TOTAL_CELLS = WEEKS * DAYS_IN_WEEK;
const DEFAULT_LEVELS = 4;
const MS_PER_DAY = 86_400_000;
const SATURDAY = 6;
/**
 * Minimum number of grid columns between two month labels. A three-letter
 * label (~3 columns wide at the cell pitch) would otherwise run into the next
 * one when a month change lands only a week or two later (e.g. "JunJul").
 */
const MIN_MONTH_LABEL_GAP = 3;

const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""] as const;
const MONTH_LABELS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

interface Cell {
	bucket: number;
	count: number;
	date: Date;
	filler: boolean;
	key: string;
}

const cn = (...classes: Array<string | false | null | undefined>): string =>
	classes.filter(Boolean).join(" ");

const pad2 = (value: number): string => value.toString().padStart(2, "0");

const toKey = (date: Date): string =>
	`${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;

const parseDay = (day: string): Date => new Date(`${day}T00:00:00Z`);

const addDays = (date: Date, days: number): Date =>
	new Date(date.getTime() + days * MS_PER_DAY);

const startOfUtcDay = (date: Date): Date =>
	new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
	);

const resolveEndDate = (data: ContributionDay[]): Date => {
	let latest: string | null = null;
	for (const entry of data) {
		if (latest === null || entry.day > latest) {
			latest = entry.day;
		}
	}
	return latest === null ? startOfUtcDay(new Date()) : parseDay(latest);
};

const bucketForCount = (
	count: number,
	maxCount: number,
	levels: number
): number => {
	if (count <= 0 || maxCount <= 0) {
		return 0;
	}
	const scaled = Math.ceil((count / maxCount) * levels);
	return Math.min(Math.max(scaled, 1), levels);
};

const buildWeeks = (data: ContributionDay[], levels: number): Cell[][] => {
	const counts = new Map<string, number>();
	let maxCount = 0;
	for (const entry of data) {
		const next = (counts.get(entry.day) ?? 0) + entry.count;
		counts.set(entry.day, next);
		if (next > maxCount) {
			maxCount = next;
		}
	}

	const endDate = resolveEndDate(data);
	const lastCell = addDays(endDate, SATURDAY - endDate.getUTCDay());
	const firstCell = addDays(lastCell, -(TOTAL_CELLS - 1));

	const weeks: Cell[][] = [];
	for (let week = 0; week < WEEKS; week += 1) {
		const days: Cell[] = [];
		for (let weekday = 0; weekday < DAYS_IN_WEEK; weekday += 1) {
			const date = addDays(firstCell, week * DAYS_IN_WEEK + weekday);
			const key = toKey(date);
			const count = counts.get(key) ?? 0;
			days.push({
				date,
				key,
				count,
				bucket: bucketForCount(count, maxCount, levels),
				filler: date.getTime() > endDate.getTime(),
			});
		}
		weeks.push(days);
	}
	return weeks;
};

const monthLabelsFor = (
	weeks: Cell[][]
): Array<{ column: number; label: string }> => {
	const labels: Array<{ column: number; label: string }> = [];
	let previousMonth = -1;
	let lastLabelColumn = Number.NEGATIVE_INFINITY;
	for (let week = 0; week < weeks.length; week += 1) {
		const firstDay = weeks[week]?.[0];
		if (!firstDay) {
			continue;
		}
		const month = firstDay.date.getUTCMonth();
		if (month === previousMonth) {
			continue;
		}
		previousMonth = month;
		// Only emit the label once the month has enough breathing room from the
		// previous one, so adjacent labels don't visually run together.
		if (week - lastLabelColumn < MIN_MONTH_LABEL_GAP) {
			continue;
		}
		labels.push({ column: week, label: MONTH_LABELS[month] ?? "" });
		lastLabelColumn = week;
	}
	return labels;
};

const cellStyleFor = (
	bucket: number,
	levels: number
): { backgroundColor?: string } => {
	if (bucket <= 0) {
		return {};
	}
	const percent = Math.round((bucket / levels) * 100);
	return {
		backgroundColor: `color-mix(in oklab, var(--primary) ${percent}%, transparent)`,
	};
};

const describeCell = (cell: Cell): string => {
	const noun = cell.count === 1 ? "contribution" : "contributions";
	return `${cell.count} ${noun} on ${cell.key}`;
};

export function ContributionsGraph({
	data,
	levels = DEFAULT_LEVELS,
	title,
}: ContributionsGraphProps) {
	const safeLevels = Math.max(1, Math.floor(levels));
	const weeks = buildWeeks(data, safeLevels);
	const monthLabels = monthLabelsFor(weeks);
	const legendBuckets = Array.from(
		{ length: safeLevels + 1 },
		(_, index) => index
	);

	return (
		<figure className="flex flex-col gap-2 text-muted-foreground text-xs">
			{title ? (
				<figcaption className="font-medium text-foreground text-sm">
					{title}
				</figcaption>
			) : null}

			<div className="flex gap-2 overflow-x-auto">
				<div
					aria-hidden="true"
					className="grid shrink-0 grid-rows-7 gap-[3px] pt-[18px] text-[10px] leading-[11px]"
				>
					{WEEKDAY_LABELS.map((label, index) => (
						<span className="h-[11px]" key={`weekday-${label || index}`}>
							{label}
						</span>
					))}
				</div>

				<div className="flex flex-col gap-1">
					<div
						aria-hidden="true"
						className="grid h-[12px] gap-[3px] text-[10px] leading-none"
						style={{ gridTemplateColumns: `repeat(${WEEKS}, 11px)` }}
					>
						{monthLabels.map((entry) => (
							<span
								key={`month-${entry.column}-${entry.label}`}
								style={{ gridColumnStart: entry.column + 1 }}
							>
								{entry.label}
							</span>
						))}
					</div>

					<div className="grid grid-flow-col grid-rows-7 gap-[3px]">
						{weeks.map((week) =>
							week.map((cell) =>
								cell.filler ? (
									<span
										aria-hidden="true"
										className="size-[11px]"
										key={cell.key}
									/>
								) : (
									<span
										className={cn(
											"size-[11px] rounded-[2px] ring-1 ring-border/60 ring-inset",
											cell.bucket <= 0 && "bg-muted"
										)}
										key={cell.key}
										style={cellStyleFor(cell.bucket, safeLevels)}
										title={describeCell(cell)}
									/>
								)
							)
						)}
					</div>
				</div>
			</div>

			<div className="flex items-center gap-1 self-end">
				<span>Less</span>
				{legendBuckets.map((bucket) => (
					<span
						className={cn(
							"size-[11px] rounded-[2px] ring-1 ring-border/60 ring-inset",
							bucket <= 0 && "bg-muted"
						)}
						key={`legend-${bucket}`}
						style={cellStyleFor(bucket, safeLevels)}
					/>
				))}
				<span>More</span>
			</div>
		</figure>
	);
}

export interface StatCardProps {
	icon?: ReactNode;
	sub?: ReactNode;
	title: string;
	value: ReactNode;
}

export function StatCard({ title, value, sub, icon }: StatCardProps) {
	return (
		<div className="flex flex-col gap-1 rounded-lg border bg-card p-4 text-card-foreground">
			<div className="flex items-center justify-between gap-2">
				<span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
					{title}
				</span>
				{icon ? (
					<span aria-hidden="true" className="text-muted-foreground">
						{icon}
					</span>
				) : null}
			</div>
			<span className="font-semibold text-2xl text-foreground tabular-nums">
				{value}
			</span>
			{sub ? (
				<span className="text-muted-foreground text-xs">{sub}</span>
			) : null}
		</div>
	);
}
