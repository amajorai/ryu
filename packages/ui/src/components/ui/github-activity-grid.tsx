"use client";

// The contribution grid and its hover tooltip, split from
// `github-activity.tsx`.

import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { MotionStyle } from "motion/react";
import { AnimatePresence, motion } from "motion/react";
import type { CSSProperties } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import { useFormatLocale } from "../../hooks/use-format-locale.ts";
import { isNativeNumber } from "../../lib/native-primitive-observation.ts";
import drawingStyles from "./github-activity.drawing.module.css";
import {
	type Contribution,
	type ContributionUnit,
	describeDay,
	gapFor,
	type LevelStyle,
	toMonthLabels,
	toWeeks,
	weeksFor,
} from "./github-activity-model.ts";

interface ContributionLevelStyle extends CSSProperties {
	"--contribution-color"?: string;
	"--contribution-opacity"?: number;
}
interface TooltipPositionStyle extends CSSProperties {
	"--github-activity-1-left"?: string | undefined;
	"--github-activity-1-top"?: string | undefined;
	"--github-activity-1-transform"?: CSSProperties["transform"];
}
interface MonthRowStyle extends MotionStyle {
	"--github-activity-2-gap"?: string | undefined;
	"--github-activity-2-margin-bottom"?: string | undefined;
}
interface MonthCellStyle extends CSSProperties {
	"--github-activity-3-width"?: string | undefined;
}
interface ContributionGridStyle extends CSSProperties {
	"--github-activity-4-gap"?: string | undefined;
}
interface ContributionWeekStyle extends CSSProperties {
	"--github-activity-5-gap"?: string | undefined;
}
interface ContributionCellStyle extends MotionStyle {
	"--github-activity-6-height"?: string | undefined;
	"--github-activity-6-width"?: string | undefined;
}
export function drawingLength(
	value: CSSProperties["width"]
): string | undefined {
	return isNativeNumber(value) ? `${value}px` : value;
}

const useIsoLayoutEffect =
	globalThis.window === undefined ? React.useEffect : React.useLayoutEffect;
const EASE_OUT = [0.22, 1, 0.36, 1] as const;
const CELL_FADE = { duration: 0.2, ease: EASE_OUT } as const;
const TOOLTIP_FADE = { duration: 0.14, ease: EASE_OUT } as const;
const TOOLTIP_EDGE = 8;
const COLUMN_STAGGER = 0.012;
const LABEL_BLUR = 6;
const LABEL_REVEAL = { duration: 0.45, ease: EASE_OUT } as const;

interface HoveredDay {
	day: Contribution;
	x: number;
	y: number;
}

function useFittedColumns(cellSize: number, gap: number) {
	const ref = React.useRef<HTMLDivElement>(null);
	const [columns, setColumns] = React.useState<number>();

	useIsoLayoutEffect(() => {
		const el = ref.current;
		if (!el) {
			return;
		}

		const measure = () =>
			setColumns(
				Math.max(1, Math.floor((el.clientWidth + gap) / (cellSize + gap)))
			);

		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [cellSize, gap]);

	return [ref, columns] as const;
}

const Tooltip = ({
	hovered,
	reduceMotion,
	unit,
}: {
	hovered: HoveredDay;
	reduceMotion: boolean | null;
	unit: ContributionUnit;
}) => {
	const ref = React.useRef<HTMLDivElement>(null);
	const [left, setLeft] = React.useState(hovered.x);
	const tl = useLiteralMessages();
	const locale = useFormatLocale();

	useIsoLayoutEffect(() => {
		const half = (ref.current?.offsetWidth ?? 0) / 2;
		const edge = TOOLTIP_EDGE + half;
		setLeft(Math.min(Math.max(hovered.x, edge), window.innerWidth - edge));
	}, [hovered]);

	const tooltipPositionStyle: TooltipPositionStyle = {
		"--github-activity-1-left": drawingLength(left),
		"--github-activity-1-top": drawingLength(hovered.y),
		"--github-activity-1-transform": "translate(-50%, calc(-100% - 8px))",
	};
	return createPortal(
		<div
			className={cn(
				"pointer-events-none fixed z-50",
				drawingStyles.tooltipPosition
			)}
			style={tooltipPositionStyle}
		>
			<motion.div
				animate={{ opacity: 1, scale: 1 }}
				className="type-caption whitespace-nowrap rounded-lg bg-foreground px-2 py-1 font-medium text-background shadow-md"
				exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
				initial={reduceMotion ? false : { opacity: 0, scale: 0.94 }}
				ref={ref}
				transition={reduceMotion ? { duration: 0 } : TOOLTIP_FADE}
			>
				{describeDay(hovered.day, unit, tl, locale)}
			</motion.div>
		</div>,
		document.body
	);
};

export const ContributionGrid = ({
	contributions,
	scale,
	cellSize,
	months,
	showMonths,
	label,
	reduceMotion,
	unit,
}: {
	contributions: Contribution[];
	scale: LevelStyle[];
	cellSize: number;
	months: number;
	showMonths: boolean;
	label: string;
	reduceMotion: boolean | null;
	unit: ContributionUnit;
}) => {
	const weeks = React.useMemo(() => toWeeks(contributions), [contributions]);
	const locale = useFormatLocale();
	const gap = gapFor(cellSize);
	const [ref, columns] = useFittedColumns(cellSize, gap);
	const [hovered, setHovered] = React.useState<HoveredDay>();

	const cap = Math.min(weeks.length, weeksFor(months));
	const visible = weeks.slice(-Math.min(cap, columns ?? cap));
	const sweepEnd = (visible.length - 1) * COLUMN_STAGGER + CELL_FADE.duration;

	const hover = (day: Contribution) => (event: React.PointerEvent) => {
		const cell = event.currentTarget.getBoundingClientRect();
		setHovered({ day, x: cell.left + cell.width / 2, y: cell.top });
	};

	const monthRowStyle: MonthRowStyle = {
		"--github-activity-2-gap": drawingLength(gap),
		"--github-activity-2-margin-bottom": drawingLength(gap),
	};
	const contributionGridStyle: ContributionGridStyle = {
		"--github-activity-4-gap": drawingLength(gap),
	};
	return (
		<div
			aria-label={label}
			className="relative"
			data-slot="github-activity-grid"
			ref={ref}
			role="img"
		>
			{showMonths && (
				<motion.div
					animate={{ opacity: 1, filter: "blur(0px)" }}
					className={cn("flex justify-center", drawingStyles.monthRow)}
					initial={
						reduceMotion
							? false
							: { opacity: 0, filter: `blur(${LABEL_BLUR}px)` }
					}
					style={monthRowStyle}
					transition={{
						...LABEL_REVEAL,
						delay: reduceMotion ? 0 : sweepEnd,
					}}
				>
					{toMonthLabels(visible, locale).map((month, index) => {
						const monthCellStyle: MonthCellStyle = {
							"--github-activity-3-width": drawingLength(cellSize),
						};
						return (
							<div
								className={cn("relative h-3 shrink-0", drawingStyles.monthCell)}
								key={index}
								style={monthCellStyle}
							>
								{month && (
									<span className="type-compact absolute start-0 top-0 text-foreground/40 leading-none">
										{month}
									</span>
								)}
							</div>
						);
					})}
				</motion.div>
			)}

			<div
				className={cn(
					"flex justify-center overflow-hidden",
					drawingStyles.contributionGrid
				)}
				onPointerLeave={() => setHovered(undefined)}
				style={contributionGridStyle}
			>
				{visible.map((week, weekIndex) => {
					const contributionWeekStyle: ContributionWeekStyle = {
						"--github-activity-5-gap": drawingLength(gap),
					};
					return (
						<div
							className={cn("flex flex-col", drawingStyles.contributionWeek)}
							key={weekIndex}
							style={contributionWeekStyle}
						>
							{week.map((day) => {
								const level = scale[day.level] ?? scale[0];
								const levelStyle: ContributionLevelStyle = {
									"--contribution-color": level?.backgroundColor,
									"--contribution-opacity": level?.opacity,
								};
								const contributionCellStyle: ContributionCellStyle = {
									"--github-activity-6-width": drawingLength(cellSize),
									"--github-activity-6-height": drawingLength(cellSize),
								};
								return (
									<motion.div
										animate={{ opacity: 1, scale: 1 }}
										className={cn(
											"shrink-0 rounded-[3px] bg-foreground/[0.08]",
											drawingStyles.contributionCell
										)}
										initial={reduceMotion ? false : { opacity: 0, scale: 0.4 }}
										key={day.date}
										onPointerEnter={hover(day)}
										style={contributionCellStyle}
										transition={{
											...CELL_FADE,
											delay: reduceMotion ? 0 : weekIndex * COLUMN_STAGGER,
										}}
									>
										<div
											className={cn(
												"h-full w-full rounded-[3px]",
												drawingStyles.level
											)}
											style={levelStyle}
										/>
									</motion.div>
								);
							})}
						</div>
					);
				})}
			</div>

			<AnimatePresence>
				{hovered && (
					<Tooltip
						hovered={hovered}
						key="tooltip"
						reduceMotion={reduceMotion}
						unit={unit}
					/>
				)}
			</AnimatePresence>
		</div>
	);
};
