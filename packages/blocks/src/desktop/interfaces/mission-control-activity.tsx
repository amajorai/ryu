import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import {
	type ActivityBucket,
	type ActivityRun,
	HOUR_MS,
	type MissionActivity,
	missionThreadTitle,
	shortTime,
} from "./mission-control-model.ts";
import { MissionPanel } from "./mission-control-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

/** Hour columns share one template so bars and axis labels line up exactly. */
const COLUMNS = "grid grid-cols-[repeat(24,minmax(0,1fr))] gap-0.5";
/** The y-axis gutter, shared by the plot, the runs row, and the time axis. */
const AXIS_ROW = "grid grid-cols-[2rem_minmax(0,1fr)] gap-x-2";
const AXIS_TEXT = "text-[11px] text-muted-foreground tabular-nums leading-none";
const TOOLTIP_TITLES = 3;

/** The smallest 1-2-5 step that splits `span` into at most three intervals. */
function niceStep(span: number): number {
	const raw = Math.max(1, span / 3);
	const magnitude = 10 ** Math.floor(Math.log10(raw));
	for (const factor of [1, 2, 5, 10]) {
		if (factor * magnitude >= raw) {
			return factor * magnitude;
		}
	}
	return 10 * magnitude;
}

/**
 * Clean y-axis ticks, top first: whole-number 1-2-5 steps whose top is the
 * first step at or above the peak, so the tallest bar meets a gridline.
 */
export function activityTicks(max: number): number[] {
	const span = Math.max(2, max);
	const step = niceStep(span);
	const top = Math.ceil(span / step) * step;
	const ticks: number[] = [];
	for (let tick = top; tick >= 0; tick -= step) {
		ticks.push(tick);
	}
	return ticks;
}

function hourRange(bucket: ActivityBucket): string {
	return `${shortTime(bucket.start)}–${shortTime(bucket.start + HOUR_MS)}`;
}

function updatesLabel(count: number): string {
	return `${count} ${count === 1 ? "thread" : "threads"} updated`;
}

function BucketTooltip({
	bucket,
	index,
	snapshot,
	total,
}: {
	bucket: ActivityBucket;
	index: number;
	snapshot: InterfaceSnapshot;
	total: number;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const titles = bucket.threadIds
		.slice(0, TOOLTIP_TITLES)
		.map((id) => snapshot.threads.find((thread) => thread.id === id))
		.filter((thread) => thread !== undefined)
		.map((thread) => ({ id: thread.id, title: missionThreadTitle(thread) }));
	const extra = bucket.threadIds.length - titles.length;
	// Beside the hovered column (never over it), on whichever side has room.
	const before = index / total > 0.5;
	const edge = before ? (index / total) * 100 : ((index + 1) / total) * 100;
	const placement = before
		? { right: `calc(${100 - edge}% + 8px)` }
		: { left: `calc(${edge}% + 8px)` };
	return (
		<motion.div
			animate={{ opacity: 1, x: 0 }}
			aria-hidden="true"
			className="pointer-events-none absolute top-0 z-10 w-56 rounded-md border border-border bg-popover px-3 py-2 text-popover-foreground shadow-foreground/10 shadow-md"
			exit={{ opacity: 0 }}
			initial={reduceMotion ? false : { opacity: 0, x: before ? 4 : -4 }}
			style={placement}
			transition={{ duration: 0.12 }}
		>
			<p className="flex items-baseline justify-between gap-2 text-xs">
				<span className="font-medium text-foreground tabular-nums">
					{hourRange(bucket)}
				</span>
				<span className="text-muted-foreground">
					{updatesLabel(bucket.count)}
				</span>
			</p>
			<ul className="mt-1.5 flex flex-col gap-1 border-border/70 border-t pt-1.5">
				{titles.map((item) => (
					<li
						className="flex min-w-0 items-center gap-1.5 text-xs"
						key={item.id}
					>
						<span className="truncate text-foreground">{item.title}</span>
					</li>
				))}
				{extra > 0 ? (
					<li className="text-muted-foreground text-xs">
						{tl("+{extra} more", { extra })}
					</li>
				) : null}
			</ul>
			<p className="mt-1.5 text-[11px] text-muted-foreground">
				Click to open the newest
			</p>
		</motion.div>
	);
}

function runLabel(run: ActivityRun): string {
	return `${run.title} ${run.outcome === "failure" ? "failed" : "succeeded"} at ${shortTime(run.at)}`;
}

const RUN_MARK: Record<ActivityRun["outcome"], string> = {
	failure: "bg-destructive",
	success: "bg-muted-foreground",
};

function RunMark({ outcome }: { outcome: ActivityRun["outcome"] }) {
	return (
		<span
			aria-hidden="true"
			className={cn("size-1.5 shrink-0 rounded-full", RUN_MARK[outcome])}
		/>
	);
}

/**
 * Finished scheduled runs as dots on their own labelled row between the plot
 * and the time axis, in the hour they ran (a rug plot), side by side when several
 * share an hour.
 */
function RunRug({ runs }: { runs: ActivityRun[] }) {
	const byHour = new Map<number, ActivityRun[]>();
	for (const run of runs) {
		byHour.set(run.hour, [...(byHour.get(run.hour) ?? []), run]);
	}
	return (
		<div className={cn(AXIS_ROW, "mt-3 h-3 items-center")}>
			<span className={cn(AXIS_TEXT, "text-right")}>Runs</span>
			<ul
				aria-label="Scheduled runs in the last 24 hours"
				className={cn(COLUMNS, "h-full items-center")}
			>
				{[...byHour.entries()].map(([hour, hourRuns]) => (
					<li
						className="flex items-center justify-center gap-0.5"
						key={hour}
						style={{ gridColumnStart: hour + 1, gridRowStart: 1 }}
						title={hourRuns.map(runLabel).join("\n")}
					>
						{hourRuns.map((run) => (
							<span className="flex" key={run.id}>
								<RunMark outcome={run.outcome} />
								<span className="sr-only">{runLabel(run)}</span>
							</span>
						))}
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * The run legend, folded into the panel's title strip. It names only the
 * outcomes the rug actually shows, so one mark never costs two entries.
 */
function RunLegend({ runs }: { runs: ActivityRun[] }) {
	const failed = runs.some((run) => run.outcome === "failure");
	const succeeded = runs.some((run) => run.outcome === "success");
	return (
		<span aria-hidden="true" className="flex shrink-0 items-center gap-3">
			{succeeded ? (
				<span className="inline-flex items-center gap-1.5">
					<RunMark outcome="success" />
					Run
				</span>
			) : null}
			{failed ? (
				<span className="inline-flex items-center gap-1.5">
					<RunMark outcome="failure" />
					Failed run
				</span>
			) : null}
		</span>
	);
}

/**
 * Threads updated per hour over the last 24 hours, one column per hour. The
 * current hour is drawn at full strength; earlier hours in a softer step of
 * the same hue. Columns with activity are buttons that open their newest
 * thread, with a tooltip naming what changed.
 */
export function ActivityChart({
	activity,
	onOpen,
	snapshot,
}: {
	activity: MissionActivity;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const [hovered, setHovered] = useState<number | null>(null);
	const { buckets, max, peak, total } = activity;
	const ticks = activityTicks(max);
	const top = ticks[0] ?? 2;
	const last = buckets.length - 1;
	const hoveredBucket = hovered === null ? undefined : buckets[hovered];
	const summary =
		total > 0 && peak
			? tl("Threads updated per hour · peak {peakTime}", {
					peakTime: shortTime(peak.start),
				})
			: "Threads updated per hour";
	const hasRuns = activity.runs.length > 0;
	const meta = (
		<>
			<span className="truncate">{summary}</span>
			{hasRuns ? <RunLegend runs={activity.runs} /> : null}
		</>
	);
	return (
		<MissionPanel meta={meta} title="Activity" titleId="mission-activity-title">
			<div className="flex min-h-0 flex-1 flex-col px-3 pt-4 pb-3">
				<div className={cn(AXIS_ROW, "min-h-32 flex-1")}>
					<ol aria-hidden="true" className={cn(AXIS_TEXT, "relative")}>
						{ticks.map((tick) => (
							<li
								className="absolute right-0 translate-y-1/2"
								key={tick}
								style={{ bottom: `${(tick / top) * 100}%` }}
							>
								{tick}
							</li>
						))}
					</ol>
					<div className="relative min-h-0">
						{ticks.map((tick) => (
							<span
								aria-hidden="true"
								className={cn(
									"absolute inset-x-0 h-px",
									tick === 0 ? "bg-border" : "bg-border/60"
								)}
								key={tick}
								style={{ bottom: `${(tick / top) * 100}%` }}
							/>
						))}
						<ul
							aria-label="Threads updated per hour, last 24 hours"
							className={cn(COLUMNS, "relative h-full")}
						>
							{buckets.map((bucket, index) => {
								const height = (bucket.count / top) * 100;
								const isCurrent = index === last;
								const newest = bucket.threadIds[0];
								const newestThread = newest
									? snapshot.threads.find((thread) => thread.id === newest)
									: undefined;
								const label = `${hourRange(bucket)}${isCurrent ? " (this hour)" : ""}: ${updatesLabel(bucket.count)}`;
								const bar = (
									<motion.span
										animate={{ height: `${height}%` }}
										aria-hidden="true"
										className={cn(
											"absolute inset-x-0 bottom-0 mx-auto w-full max-w-5 rounded-t-[2px] transition-colors",
											isCurrent || hovered === index
												? "bg-primary"
												: "bg-primary/55"
										)}
										initial={reduceMotion ? false : { height: "0%" }}
										transition={{
											delay: reduceMotion ? 0 : index * 0.012,
											duration: 0.35,
											ease: [0.2, 0, 0, 1],
										}}
									/>
								);
								return (
									<li
										className="relative h-full min-w-0"
										data-hour={index}
										key={bucket.start}
									>
										{bucket.count > 0 && newest ? (
											<button
												aria-label={tl(
													"{label}. Open the newest, {threadTitle}",
													{
														label,
														threadTitle: newestThread
															? missionThreadTitle(newestThread)
															: tl("thread"),
													}
												)}
												className="absolute inset-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
												onBlur={() => setHovered(null)}
												onClick={() => onOpen(newest)}
												onFocus={() => setHovered(index)}
												onMouseEnter={() => setHovered(index)}
												onMouseLeave={() => setHovered(null)}
												type="button"
											>
												{bar}
											</button>
										) : (
											<span className="sr-only">{label}</span>
										)}
									</li>
								);
							})}
						</ul>
						<AnimatePresence>
							{hoveredBucket && hovered !== null ? (
								<BucketTooltip
									bucket={hoveredBucket}
									index={hovered}
									key={hoveredBucket.start}
									snapshot={snapshot}
									total={buckets.length}
								/>
							) : null}
						</AnimatePresence>
						{total === 0 ? (
							<p className="absolute inset-0 flex items-center justify-center text-muted-foreground text-xs">
								No thread updates in the last 24 hours
							</p>
						) : null}
					</div>
				</div>
				{hasRuns ? <RunRug runs={activity.runs} /> : null}
				<div aria-hidden="true" className={cn(AXIS_ROW, "mt-2 h-3")}>
					<span />
					<div className={cn(COLUMNS, AXIS_TEXT)}>
						{buckets.map((bucket, index) => {
							let text = "";
							if (index === last) {
								text = "Now";
							} else if (index % 6 === 0) {
								text = shortTime(bucket.start);
							}
							// Every label centres on its own bar.
							return (
								<span className="relative" key={bucket.start}>
									{text ? (
										<span className="absolute top-0 left-1/2 -translate-x-1/2 whitespace-nowrap">
											{text}
										</span>
									) : null}
								</span>
							);
						})}
					</div>
				</div>
			</div>
		</MissionPanel>
	);
}
