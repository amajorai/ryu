import type { CSSProperties } from "react";
import { isNativeNumber } from "../lib/native-primitive-observation.ts";
import { cn } from "../lib/utils.ts";

/** The states a scheduled run can show in a compact timeline. */
export type RunStatusTimelineStatus =
	| "disabled"
	| "failure"
	| "running"
	| "scheduled"
	| "success"
	| "waiting";

/** One run positioned against the timeline's absolute millisecond window. */
export interface RunStatusTimelineEntry {
	endAt?: number;
	id: string;
	label: string;
	startAt: number;
	status: RunStatusTimelineStatus;
}

interface TimelinePlacementStyle extends CSSProperties {
	"--timeline-left": string;
	"--timeline-width"?: string;
}

interface StatusMeta {
	className: string;
	label: string;
}

const STATUS_META = {
	disabled: { className: "bg-muted-foreground/35", label: "Disabled" },
	failure: { className: "bg-destructive", label: "Failed" },
	running: { className: "bg-primary", label: "Running" },
	scheduled: { className: "bg-warning", label: "Scheduled" },
	success: { className: "bg-success", label: "Succeeded" },
	waiting: { className: "bg-warning/65", label: "Awaiting input" },
} satisfies Record<RunStatusTimelineStatus, StatusMeta>;

const LEGEND_STATUSES: RunStatusTimelineStatus[] = [
	"success",
	"failure",
	"scheduled",
];
const HOUR_TICKS = [0, 6, 12, 18, 24];
const MINIMUM_POINT_WIDTH_PERCENT = 0.75;

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function entryPlacement(
	entry: RunStatusTimelineEntry,
	startAt: number,
	endAt: number
): { left: number; width: number } | null {
	if (!Number.isFinite(entry.startAt)) {
		return null;
	}

	const entryStart = entry.startAt;
	const rawEnd = entry.endAt;
	const entryEnd =
		isNativeNumber(rawEnd) && Number.isFinite(rawEnd)
			? Math.max(rawEnd, entryStart + 1)
			: entryStart + 1;
	if (entryStart >= endAt || entryEnd <= startAt) {
		return null;
	}

	const visibleStart = clamp(entryStart, startAt, endAt);
	const visibleEnd = clamp(entryEnd, startAt, endAt);
	const range = endAt - startAt;
	const left = ((visibleStart - startAt) / range) * 100;
	const width = Math.max(
		((visibleEnd - visibleStart) / range) * 100,
		MINIMUM_POINT_WIDTH_PERCENT
	);
	const safeWidth = Math.min(width, 100);

	return {
		left: Math.min(left, 100 - safeWidth),
		width: safeWidth,
	};
}

/** The shared color key for run status strips. */
export function RunStatusTimelineLegend({
	className,
	statuses = LEGEND_STATUSES,
}: {
	className?: string;
	statuses?: RunStatusTimelineStatus[];
}) {
	return (
		<div
			aria-label="Run status legend"
			className={cn(
				"type-caption flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground",
				className
			)}
			role="list"
		>
			{statuses.map((status) => (
				<span
					className="inline-flex items-center gap-1.5"
					key={status}
					role="listitem"
				>
					<span
						aria-hidden="true"
						className={cn(
							"size-1.5 rounded-[2px]",
							STATUS_META[status].className
						)}
					/>
					{STATUS_META[status].label}
				</span>
			))}
		</div>
	);
}

/**
 * A compact 24-hour run strip. Completed runs use their outcome, projected
 * firings use amber, and point-in-time runs stay visible with a minimum width
 * so a short run is still discoverable at normal UI sizes.
 */
export function RunStatusTimeline({
	ariaLabel,
	className,
	endAt,
	entries,
	nowAt,
	showScale = false,
	startAt,
}: {
	ariaLabel: string;
	className?: string;
	endAt: number;
	entries: RunStatusTimelineEntry[];
	nowAt?: number;
	showScale?: boolean;
	startAt: number;
}) {
	const validWindow =
		Number.isFinite(startAt) && Number.isFinite(endAt) && endAt > startAt;
	const placements = validWindow
		? entries
				.map((entry) => ({
					entry,
					placement: entryPlacement(entry, startAt, endAt),
				}))
				.filter(
					(
						item
					): item is {
						entry: RunStatusTimelineEntry;
						placement: { left: number; width: number };
					} => item.placement !== null
				)
		: [];
	const showNow =
		validWindow &&
		isNativeNumber(nowAt) &&
		Number.isFinite(nowAt) &&
		nowAt > startAt &&
		nowAt < endAt;
	const nowStyle: TimelinePlacementStyle | undefined = showNow
		? {
				"--timeline-left": `${((nowAt - startAt) / (endAt - startAt)) * 100}%`,
			}
		: undefined;

	return (
		<div className={cn("min-w-0", className)} data-slot="run-status-timeline">
			<div
				aria-label={ariaLabel}
				className="relative h-3.5 overflow-hidden rounded-[3px] bg-muted/55 ring-1 ring-border/60"
				role="group"
			>
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0"
				>
					{HOUR_TICKS.map((hour) => {
						const tickStyle: TimelinePlacementStyle = {
							"--timeline-left": `${(hour / 24) * 100}%`,
						};
						return (
							<span
								className="absolute inset-y-0 left-[var(--timeline-left)] w-px bg-border/55"
								key={hour}
								style={tickStyle}
							/>
						);
					})}
				</div>
				{placements.map(({ entry, placement }) => {
					const entryStyle: TimelinePlacementStyle = {
						"--timeline-left": `${placement.left}%`,
						"--timeline-width": `${placement.width}%`,
					};
					return (
						<span
							aria-label={entry.label}
							className={cn(
								"absolute top-0.5 bottom-0.5 left-[var(--timeline-left)] w-[var(--timeline-width)] rounded-[2px] transition-[filter] hover:brightness-110",
								STATUS_META[entry.status].className
							)}
							key={entry.id}
							role="img"
							style={entryStyle}
							title={entry.label}
						/>
					);
				})}
				{showNow ? (
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-y-0 left-[var(--timeline-left)] z-10 w-px bg-foreground/70"
						style={nowStyle}
					/>
				) : null}
			</div>
			{showScale ? (
				<div
					aria-hidden="true"
					className="type-micro mt-1 flex justify-between font-mono text-muted-foreground tabular-nums"
				>
					{HOUR_TICKS.map((hour) => (
						<span key={hour}>
							{hour === 24 ? "24:00" : `${String(hour).padStart(2, "0")}:00`}
						</span>
					))}
				</div>
			) : null}
			<p className="sr-only">
				{entries.length === 0
					? "No runs recorded in this 24-hour period."
					: entries.map((entry) => entry.label).join(". ")}
			</p>
		</div>
	);
}
