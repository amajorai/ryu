import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { WidgetEmpty } from "./dashboard-lists.tsx";
import {
	type ActivityBucket,
	activityTicks,
	type DashboardActivity,
	HOUR_MS,
	hourLabel,
	plural,
	threadTitle,
} from "./dashboard-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/** Bars and axis labels share one template so they line up exactly. */
const COLUMNS = "grid grid-cols-[repeat(24,minmax(0,1fr))]";
/** Hour labels every six hours, then "Now" under the current hour. */
const LABEL_EVERY = 6;
const TOOLTIP_TITLES = 3;

function hourRange(bucket: ActivityBucket): string {
	return `${hourLabel(bucket.start)} – ${hourLabel(bucket.start + HOUR_MS)}`;
}

function BucketTooltip({
	bucket,
	index,
	snapshot,
}: {
	bucket: ActivityBucket;
	index: number;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const titles = bucket.threadIds
		.slice(0, TOOLTIP_TITLES)
		.map((id) => snapshot.threads.find((thread) => thread.id === id))
		.filter((thread) => thread !== undefined);
	const extra = bucket.threadIds.length - titles.length;
	// Beside the hovered column, never over it, on whichever side has room.
	const before = index >= 12;
	const edge = before ? (index / 24) * 100 : ((index + 1) / 24) * 100;
	return (
		<motion.div
			animate={{ opacity: 1 }}
			aria-hidden="true"
			className="pointer-events-none absolute top-0 z-10 w-56 rounded-md border border-border bg-popover px-3 py-2 text-popover-foreground shadow-foreground/10 shadow-md"
			exit={{ opacity: 0 }}
			initial={reduceMotion ? false : { opacity: 0 }}
			style={
				before
					? { right: `calc(${100 - edge}% + 8px)` }
					: { left: `calc(${edge}% + 8px)` }
			}
			transition={{ duration: 0.1 }}
		>
			<p className="flex items-baseline justify-between gap-3 text-xs">
				<span className="font-medium text-foreground tabular-nums">
					{plural(bucket.count, "thread")}
				</span>
				<span className="text-muted-foreground tabular-nums">
					{hourRange(bucket)}
				</span>
			</p>
			<ul className="mt-1.5 flex flex-col gap-1 border-border border-t pt-1.5">
				{titles.map((thread) => (
					<li className="truncate text-foreground text-xs" key={thread.id}>
						{threadTitle(thread)}
					</li>
				))}
				{extra > 0 ? (
					<li className="text-muted-foreground text-xs">
						{tl("{extra} more", { extra })}
					</li>
				) : null}
			</ul>
		</motion.div>
	);
}

/**
 * Threads updated per hour across the last 24 hours: one series, so no
 * legend; the widget title names it. Hours with activity are buttons that
 * open their newest thread, and hover or focus shows which threads moved.
 */
export function ActivityChart({
	activity,
	onOpen,
	snapshot,
}: {
	activity: DashboardActivity;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const [hovered, setHovered] = useState<number | null>(null);
	const { buckets, max, total } = activity;
	if (total === 0) {
		return (
			<WidgetEmpty>No thread was updated in the last 24 hours.</WidgetEmpty>
		);
	}
	const ticks = activityTicks(max);
	const top = ticks[0];
	const last = buckets.length - 1;
	const hoveredBucket = hovered === null ? undefined : buckets[hovered];
	return (
		<div className="@container/chart flex min-h-0 flex-1 flex-col px-4 pt-1 pb-3">
			<div className="grid min-h-0 flex-1 grid-cols-[1.25rem_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] gap-x-3">
				<ol
					aria-hidden="true"
					className="relative text-right text-muted-foreground text-xs tabular-nums leading-none"
				>
					{ticks.map((tick) => (
						<li
							className="absolute right-0 -translate-y-1/2"
							key={tick}
							style={{ top: `${(1 - tick / top) * 100}%` }}
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
							style={{ top: `${(1 - tick / top) * 100}%` }}
						/>
					))}
					<ol
						aria-label="Threads updated per hour"
						className={cn(COLUMNS, "relative size-full gap-0.5")}
						onPointerLeave={() => setHovered(null)}
					>
						{buckets.map((bucket, index) => {
							const height = `${(bucket.count / top) * 100}%`;
							const dimmed = hovered !== null && hovered !== index;
							const bar = (
								<span
									aria-hidden="true"
									className={cn(
										"mx-auto block w-full max-w-6 rounded-t-[4px] bg-primary transition-opacity duration-100",
										dimmed && "opacity-35"
									)}
									style={{ height }}
								/>
							);
							if (bucket.count === 0) {
								return (
									<li
										aria-hidden="true"
										className="h-full"
										key={bucket.start}
									/>
								);
							}
							const newest = bucket.threadIds[0];
							return (
								<li className="flex h-full" key={bucket.start}>
									<button
										aria-label={tl(
											"{hours}: {count, plural, one {{countText} thread} other {{countText} threads}} updated. Open the newest.",
											{
												count: bucket.count,
												countText: String(bucket.count),
												hours: hourRange(bucket),
											}
										)}
										className="flex size-full flex-col justify-end rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
										onBlur={() => setHovered(null)}
										onClick={() => (newest ? onOpen(newest) : undefined)}
										onFocus={() => setHovered(index)}
										onPointerEnter={() => setHovered(index)}
										type="button"
									>
										{bar}
									</button>
								</li>
							);
						})}
					</ol>
					<AnimatePresence>
						{hoveredBucket && hovered !== null ? (
							<BucketTooltip
								bucket={hoveredBucket}
								index={hovered}
								key={hoveredBucket.start}
								snapshot={snapshot}
							/>
						) : null}
					</AnimatePresence>
				</div>
				<span aria-hidden="true" />
				<ol
					aria-hidden="true"
					className={cn(
						COLUMNS,
						"mt-2 text-muted-foreground text-xs tabular-nums leading-4"
					)}
				>
					{buckets.map((bucket, index) => {
						const isNow = index === last;
						const show =
							isNow || (index % LABEL_EVERY === 0 && index < last - 2);
						return (
							<li
								className={cn(
									"whitespace-nowrap",
									isNow
										? "justify-self-end text-foreground"
										: "justify-self-start",
									// Narrow widgets keep every twelfth hour so labels never touch.
									!isNow &&
										index % (LABEL_EVERY * 2) !== 0 &&
										"@max-[400px]/chart:invisible"
								)}
								key={bucket.start}
							>
								{show ? (isNow ? "Now" : hourLabel(bucket.start)) : null}
							</li>
						);
					})}
				</ol>
			</div>
		</div>
	);
}
