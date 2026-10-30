"use client";

import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import styles from "./contributions-graph.module.css";
import {
	buildWeeks,
	type Cell,
	type ContributionsGraphGeometry,
	cornersClassFor,
	DEFAULT_LEVELS,
	GitHubIcon,
	GLOW_INTENSITY,
	glowColorFor,
	levelClassFor,
} from "./contributions-graph-cells.tsx";

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
	/**
	 * Marks a day as active even when `count` is zero (for example a day kept
	 * alive by activity that carries no metered count). Such a day renders at
	 * the lowest filled intensity instead of empty.
	 */
	active?: boolean;
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
export type ContributionsGraphCorners =
	| "square"
	| "rounded"
	| "circle"
	| "squircle";

export type { ContributionsGraphCorners as ContributionsGraphShape };

export interface ContributionsGraphProps {
	className?: string;
	/** Color scheme for the contribution cells. Default "green". */
	colorSchema?: ContributionsGraphColorSchema;
	data: ContributionDay[];
	/** Number of filled intensity buckets (excludes the empty bucket). */
	levels?: number;
	/** Cell shape. Default "rounded". */
	shape?: ContributionsGraphCorners;
	/** Whether to show the total-contributions header. Default true. */
	showTotal?: boolean;
	/** Header label, rendered where the reference component shows "@username". */
	title?: string;
	/** Visual style variant. Default "default". */
	variant?: ContributionsGraphVariant;
}

/**
 * Builds heatmap data from a per-day count series plus an optional list of
 * active days (a day can be active with no count row at all). Days only in
 * `activeDays` are added with a zero count; both inputs are optional so older
 * responses without activity data render exactly as before.
 */
export function withActiveDays(
	days: ReadonlyArray<{ active?: boolean; count: number; day: string }>,
	activeDays?: readonly string[]
): ContributionDay[] {
	const active = new Set(activeDays ?? []);
	const merged: ContributionDay[] = days.map((entry) => ({
		day: entry.day,
		count: entry.count,
		active: entry.active === true || active.has(entry.day),
	}));
	const seen = new Set(days.map((entry) => entry.day));
	for (const day of active) {
		if (!seen.has(day)) {
			merged.push({ day, count: 0, active: true });
		}
	}
	return merged;
}

export function ContributionsGraph({
	data,
	levels = DEFAULT_LEVELS,
	title,
	className,
	variant = "default",
	colorSchema = "green",
	shape: corners = "rounded",
	showTotal = true,
}: ContributionsGraphProps) {
	const safeLevels = Math.max(1, Math.floor(levels));
	const weeks = buildWeeks(data, safeLevels);
	let total = 0;
	for (const entry of data) {
		total += entry.count;
	}

	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();
	const reduce = useReducedMotion();
	const [mounted, setMounted] = useState(false);
	const animate = mounted && !reduce;

	useEffect(() => {
		setMounted(true);
	}, []);

	const gridRef = useRef<HTMLDivElement>(null);
	const [hovered, setHovered] = useState<{
		active: boolean;
		count: number;
		date: string;
	} | null>(null);
	const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

	const tooltipPosition: ContributionsGraphGeometry = {
		"--contribution-tooltip-left": `${mousePos.x}px`,
		"--contribution-tooltip-top": `${mousePos.y - 40}px`,
	};

	const tooltipValues = {
		count: String(hovered?.count ?? 0),
		date: hovered?.date ?? "",
	};
	const tooltipTags = {
		count: (chunks: ReactNode) => (
			<span className="mr-1 font-medium">{chunks}</span>
		),
		description: (chunks: ReactNode) => (
			<span className={styles.tooltipDescription}>{chunks}</span>
		),
	};

	const isGlowing = variant === "city-lights";
	const isMinimal = variant === "minimal";
	const cornersClass = cornersClassFor(corners);
	const glowColor = glowColorFor(colorSchema);

	const handleCellEnter =
		(cell: Cell) => (event: { currentTarget: HTMLDivElement }) => {
			setHovered({ active: cell.active, count: cell.count, date: cell.key });
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
						cornersClass
					)}
					key={cell.key}
				/>
			);
		}

		const className = cn(
			"aspect-square w-full transition-colors duration-200",
			levelClassFor(cell.bucket, colorSchema),
			isGlowing && cell.bucket > 0 && "z-10",
			isGlowing && cell.bucket > 0 && styles.glowingCell,
			cornersClass
		);
		const glowStyle: ContributionsGraphGeometry | undefined =
			isGlowing && cell.bucket > 0
				? {
						"--contribution-cell-shadow": `0 0 ${
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
					style={glowStyle}
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
				style={glowStyle}
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
						{tl("{count} contributions in the last year", {
							count: formatCount(total),
						})}
					</span>
				</div>
			) : null}

			<div className="overflow-x-auto">
				<div
					className={cn("relative flex w-max flex-nowrap", styles.cellGap)}
					onMouseLeave={() => setHovered(null)}
					ref={gridRef}
				>
					<AnimatePresence>
						{hovered ? (
							<motion.div
								animate={{ opacity: 1, scale: 1, y: 0 }}
								className={cn(
									"pointer-events-none absolute z-50",
									styles.tooltipPosition
								)}
								exit={{ opacity: 0, scale: 0.9, y: 5 }}
								initial={{ opacity: 0, scale: 0.9, y: 10 }}
								key="tooltip"
								style={tooltipPosition}
								transition={{ duration: 0.2 }}
							>
								<span
									className={cn(
										"block -translate-x-1/2 whitespace-nowrap rounded-md px-3 py-1.5 text-xs shadow-xl",
										styles.tooltip
									)}
								>
									{hovered.active && hovered.count === 0
										? tlRich(
												"<count>{count}</count><description>contributions on {date} · active</description>",
												tooltipValues,
												tooltipTags
											)
										: tlRich(
												"<count>{count}</count><description>contributions on {date}</description>",
												tooltipValues,
												tooltipTags
											)}
								</span>
							</motion.div>
						) : null}
					</AnimatePresence>

					{weeks.map((week, weekIndex) => (
						<div className={cn("flex flex-col", styles.week)} key={weekIndex}>
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

export type { StatCardProps } from "./contributions-graph-stat-card.tsx";
export { StatCard } from "./contributions-graph-stat-card.tsx";
