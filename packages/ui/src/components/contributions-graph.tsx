"use client";

import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * GitHub-style contributions heatmap, ported from the Componentry
 * `<GithubCalendar />` (componentry.dev/docs/components/github-calendar): the
 * same 53-week cell grid, color schemas, display variants, entrance animation
 * and hover tooltip. Unlike the reference (which fetches a GitHub username),
 * this one is data-driven — it renders the `data: { day, count }[]` series it
 * is handed, so it stays backend-agnostic across the desktop and web stats
 * pages.
 *
 * SSR-safe: like NumberTicker, the staggered cell animation only runs once
 * mounted (and is skipped under reduced motion), so the server and the first
 * client render share the same static markup and hydration never mismatches.
 */

export interface ContributionDay {
	count: number;
	day: string;
}

export type ContributionsGraphVariant = "default" | "city-lights" | "minimal";
export type ContributionsGraphColorSchema =
	| "green"
	| "blue"
	| "purple"
	| "orange"
	| "gray";
export type ContributionsGraphShape =
	| "square"
	| "rounded"
	| "circle"
	| "squircle";

export interface ContributionsGraphProps {
	className?: string;
	/** Color scheme for the contribution cells. Default "green". */
	colorSchema?: ContributionsGraphColorSchema;
	data: ContributionDay[];
	/** Number of filled intensity buckets (excludes the empty bucket). */
	levels?: number;
	/** Cell shape. Default "rounded". */
	shape?: ContributionsGraphShape;
	/** Whether to show the total-contributions header. Default true. */
	showTotal?: boolean;
	/** Header label, rendered where the reference component shows "@username". */
	title?: string;
	/** Visual style variant. Default "default". */
	variant?: ContributionsGraphVariant;
}

const WEEKS = 53;
const DAYS_IN_WEEK = 7;
const TOTAL_CELLS = WEEKS * DAYS_IN_WEEK;
const DEFAULT_LEVELS = 4;
const MS_PER_DAY = 86_400_000;
const SATURDAY = 6;
const GLOW_INTENSITY = 5;

interface Cell {
	bucket: number;
	count: number;
	date: Date;
	filler: boolean;
	key: string;
}

interface LevelClasses {
	level0: string;
	level1: string;
	level2: string;
	level3: string;
	level4: string;
}

const colorSchemas: Record<ContributionsGraphColorSchema, LevelClasses> = {
	gray: {
		level0: "bg-zinc-100 dark:bg-zinc-900",
		level1: "bg-zinc-300 dark:bg-zinc-800",
		level2: "bg-zinc-400 dark:bg-zinc-700",
		level3: "bg-zinc-600 dark:bg-zinc-500",
		level4: "bg-zinc-800 dark:bg-zinc-300",
	},
	green: {
		level0: "bg-zinc-100 dark:bg-zinc-900",
		level1: "bg-emerald-200 dark:bg-emerald-900",
		level2: "bg-emerald-300 dark:bg-emerald-700",
		level3: "bg-emerald-400 dark:bg-emerald-500",
		level4: "bg-emerald-500 dark:bg-emerald-400",
	},
	blue: {
		level0: "bg-zinc-100 dark:bg-zinc-900",
		level1: "bg-blue-200 dark:bg-blue-900",
		level2: "bg-blue-300 dark:bg-blue-700",
		level3: "bg-blue-400 dark:bg-blue-500",
		level4: "bg-blue-500 dark:bg-blue-400",
	},
	purple: {
		level0: "bg-zinc-100 dark:bg-zinc-900",
		level1: "bg-purple-200 dark:bg-purple-900",
		level2: "bg-purple-300 dark:bg-purple-700",
		level3: "bg-purple-400 dark:bg-purple-500",
		level4: "bg-purple-500 dark:bg-purple-400",
	},
	orange: {
		level0: "bg-zinc-100 dark:bg-zinc-900",
		level1: "bg-orange-200 dark:bg-orange-900",
		level2: "bg-orange-300 dark:bg-orange-700",
		level3: "bg-orange-400 dark:bg-orange-500",
		level4: "bg-orange-500 dark:bg-orange-400",
	},
};

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

const levelClassFor = (
	bucket: number,
	schema: ContributionsGraphColorSchema
): string => {
	const levels = colorSchemas[schema];
	if (bucket <= 0) {
		return levels.level0;
	}
	if (bucket === 1) {
		return levels.level1;
	}
	if (bucket === 2) {
		return levels.level2;
	}
	if (bucket === 3) {
		return levels.level3;
	}
	return levels.level4;
};

const shapeClassFor = (shape: ContributionsGraphShape): string => {
	if (shape === "circle") {
		return "rounded-full";
	}
	if (shape === "square") {
		return "rounded-none";
	}
	if (shape === "squircle") {
		return "rounded-sm";
	}
	return "rounded-[2px]";
};

const glowColorFor = (schema: ContributionsGraphColorSchema): string => {
	if (schema === "blue") {
		return "#3b82f6";
	}
	if (schema === "purple") {
		return "#a855f7";
	}
	if (schema === "orange") {
		return "#f97316";
	}
	return "#10b981";
};

const GitHubIcon = (
	<svg
		aria-hidden="true"
		className="fill-current text-muted-foreground"
		data-view-component="true"
		height="16"
		viewBox="0 0 16 16"
		width="16"
	>
		<path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
	</svg>
);

export function ContributionsGraph({
	data,
	levels = DEFAULT_LEVELS,
	title,
	className,
	variant = "default",
	colorSchema = "green",
	shape = "rounded",
	showTotal = true,
}: ContributionsGraphProps) {
	const safeLevels = Math.max(1, Math.floor(levels));
	const weeks = buildWeeks(data, safeLevels);
	let total = 0;
	for (const entry of data) {
		total += entry.count;
	}

	const reduce = useReducedMotion();
	const [mounted, setMounted] = useState(false);
	const animate = mounted && !reduce;

	useEffect(() => {
		setMounted(true);
	}, []);

	const gridRef = useRef<HTMLDivElement>(null);
	const [hovered, setHovered] = useState<{
		count: number;
		date: string;
	} | null>(null);
	const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

	const isGlowing = variant === "city-lights";
	const isMinimal = variant === "minimal";
	const shapeClass = shapeClassFor(shape);
	const glowColor = glowColorFor(colorSchema);

	const handleCellEnter =
		(cell: Cell) => (event: { currentTarget: HTMLDivElement }) => {
			setHovered({ count: cell.count, date: cell.key });
			const rect = event.currentTarget.getBoundingClientRect();
			const parent = gridRef.current?.getBoundingClientRect();
			if (parent) {
				setMousePos({
					x: rect.left - parent.left + rect.width / 2,
					y: rect.top - parent.top,
				});
			}
		};

	const renderCell = (cell: Cell, weekIndex: number, dayIndex: number) => {
		if (cell.filler) {
			return (
				<span
					aria-hidden="true"
					className={cn(
						"aspect-square w-full",
						levelClassFor(0, colorSchema),
						shapeClass
					)}
					key={cell.key}
				/>
			);
		}

		const className = cn(
			"aspect-square w-full transition-colors duration-200",
			levelClassFor(cell.bucket, colorSchema),
			isGlowing && cell.bucket > 0 && "z-10",
			shapeClass
		);
		const style =
			isGlowing && cell.bucket > 0
				? {
						boxShadow: `0 0 ${
							cell.count > 3 ? GLOW_INTENSITY * 1.5 : GLOW_INTENSITY
						}px ${glowColor}`,
					}
				: undefined;

		if (!animate) {
			return (
				<div
					className={cn(className, isMinimal && "scale-75")}
					key={cell.key}
					onMouseEnter={handleCellEnter(cell)}
					style={style}
				/>
			);
		}

		return (
			<motion.div
				animate={{ opacity: 1, scale: isMinimal ? 0.75 : 1 }}
				className={className}
				initial={{ opacity: 0, scale: 0 }}
				key={cell.key}
				onMouseEnter={handleCellEnter(cell)}
				style={style}
				transition={{
					delay: weekIndex * 0.01 + dayIndex * 0.01,
					type: "spring",
					stiffness: 260,
					damping: 20,
				}}
			/>
		);
	};

	return (
		<div className={cn("flex w-full flex-col gap-4", className)}>
			{showTotal ? (
				<div className="flex items-center justify-between gap-4">
					<div className="flex items-center gap-2">
						{GitHubIcon}
						<span className="font-medium text-sm">{title ?? "Activity"}</span>
					</div>
					<span className="text-muted-foreground text-sm">
						{formatCount(total)} contributions in the last year
					</span>
				</div>
			) : null}

			<div className="overflow-x-auto">
				<div
					className="relative flex w-max flex-nowrap gap-[3px]"
					onMouseLeave={() => setHovered(null)}
					ref={gridRef}
				>
					<AnimatePresence>
						{hovered ? (
							<motion.div
								animate={{ opacity: 1, scale: 1, y: 0 }}
								className="pointer-events-none absolute z-50"
								exit={{ opacity: 0, scale: 0.9, y: 5 }}
								initial={{ opacity: 0, scale: 0.9, y: 10 }}
								key="tooltip"
								style={{ left: mousePos.x, top: mousePos.y - 40 }}
								transition={{ duration: 0.2 }}
							>
								<span className="block -translate-x-1/2 whitespace-nowrap rounded-md bg-zinc-900 px-3 py-1.5 text-white text-xs shadow-xl dark:bg-white dark:text-zinc-900">
									<span className="mr-1 font-medium">{hovered.count}</span>
									<span className="text-zinc-400 dark:text-zinc-500">
										contributions on {hovered.date}
									</span>
								</span>
							</motion.div>
						) : null}
					</AnimatePresence>

					{weeks.map((week, weekIndex) => (
						<div className="flex w-[14px] flex-col gap-[3px]" key={weekIndex}>
							{week.map((cell, dayIndex) =>
								renderCell(cell, weekIndex, dayIndex)
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

export interface StatCardProps {
	chart?: ReactNode;
	className?: string;
	icon?: ReactNode;
	sub?: ReactNode;
	title: string;
	value: ReactNode;
}

export function StatCard({
	chart,
	className,
	title,
	value,
	sub,
	icon,
}: StatCardProps) {
	return (
		<div
			className={cn(
				"flex flex-col gap-1 rounded-4xl bg-card p-4 text-card-foreground shadow-sm",
				className
			)}
		>
			<div className="flex items-center justify-between gap-2">
				<span className="font-medium text-muted-foreground text-xs">
					{title}
				</span>
				{icon ? (
					<span
						aria-hidden="true"
						className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
					>
						{icon}
					</span>
				) : null}
			</div>
			<span className="font-medium font-mono text-2xl text-foreground tabular-nums">
				{value}
			</span>
			{sub ? (
				<span className="text-muted-foreground text-xs">{sub}</span>
			) : null}
			{chart ? <div className="mt-auto pt-2">{chart}</div> : null}
		</div>
	);
}
