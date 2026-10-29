import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	THREAD_STATUS_LABELS,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import type { KeyboardEvent } from "react";
import { type FocusItem, focusRuns } from "./focus-model.ts";

/** Matches the strip, so the page-level J/K/arrow shortcuts leave it alone. */
export const FOCUS_STRIP_SELECTOR = "[data-focus-strip]";

/**
 * Upcoming segments stay neutral so the title, not the strip, is the loudest
 * thing on the page. Only a failed run keeps its tint ahead of you; a live run
 * breathes (motion permitting) instead of taking a colour.
 */
const NEUTRAL_AHEAD =
	"bg-muted-foreground/45 group-hover/segment:bg-muted-foreground/80 dark:bg-muted-foreground/70 dark:group-hover/segment:bg-muted-foreground";
const AHEAD: Record<ThreadStatus, string> = {
	attention: "bg-destructive/60 group-hover/segment:bg-destructive",
	quiet: NEUTRAL_AHEAD,
	waiting: NEUTRAL_AHEAD,
	working: `animate-pulse motion-reduce:animate-none ${NEUTRAL_AHEAD}`,
	"your-turn": NEUTRAL_AHEAD,
};

/** The current segment is solid; neutral statuses take the full foreground. */
const CURRENT: Record<ThreadStatus, string> = {
	attention: "bg-destructive",
	quiet: "bg-foreground",
	waiting: "bg-foreground",
	working: "bg-success",
	"your-turn": "bg-primary",
};

/** Clearly weaker than anything ahead, so the strip reads as progress. */
const SEEN = "bg-foreground/10 group-hover/segment:bg-foreground/30";

const NAVIGATION_KEYS = new Set(["ArrowLeft", "ArrowRight", "End", "Home"]);

function targetIndex(key: string, from: number, total: number): number {
	switch (key) {
		case "ArrowLeft":
			return Math.max(from - 1, 0);
		case "ArrowRight":
			return Math.min(from + 1, total - 1);
		case "Home":
			return 0;
		default:
			return total - 1;
	}
}

/**
 * The queue as a slim segmented bar: one segment per thread, grouped into
 * status runs. Seen segments fade to a faint rule, the current one is solid,
 * and the rest stay neutral (a failed run keeps its tint). Every segment has
 * the same height, so the strip has one clean edge. The strip
 * is one tab stop (a roving tabindex): Left/Right/Home/End move through it
 * and jump the queue with them, and every segment is also clickable.
 */
export function FocusStrip({
	currentIndex,
	density = "regular",
	onSelect,
	queue,
}: {
	currentIndex: number;
	density?: "regular" | "slim";
	onSelect: (index: number) => void;
	queue: FocusItem[];
}) {
	if (queue.length === 0) {
		return null;
	}
	const slim = density === "slim";
	const total = queue.length;
	const tabbable = Math.min(Math.max(currentIndex, 0), total - 1);

	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (
			!NAVIGATION_KEYS.has(event.key) ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.shiftKey
		) {
			return;
		}
		const button =
			event.target instanceof HTMLElement
				? event.target.closest<HTMLElement>("[data-segment-index]")
				: null;
		const from = Number(button?.dataset.segmentIndex ?? tabbable);
		const next = targetIndex(event.key, from, total);
		event.preventDefault();
		if (next === from) {
			return;
		}
		event.currentTarget
			.querySelector<HTMLElement>(`[data-segment-index="${next}"]`)
			?.focus();
		onSelect(next);
	};

	return (
		<nav
			aria-label="Queue"
			className="w-full min-w-0"
			data-focus-strip=""
			onKeyDown={onKeyDown}
		>
			<ol className={cn("flex w-full min-w-0", slim ? "gap-1" : "gap-2")}>
				{focusRuns(queue).map((run) => (
					<li
						className="flex min-w-0 flex-1"
						key={`${run.status}-${run.items[0]?.index ?? 0}`}
						style={{ flexGrow: run.items.length }}
					>
						<ol
							aria-label={THREAD_STATUS_LABELS[run.status]}
							className="flex w-full min-w-0 gap-0.5"
						>
							{run.items.map(({ index, item }) => (
								<FocusSegment
									current={index === currentIndex}
									index={index}
									item={item}
									key={item.thread.id}
									onSelect={onSelect}
									seen={index < currentIndex}
									slim={slim}
									tabbable={index === tabbable}
									total={total}
								/>
							))}
						</ol>
					</li>
				))}
			</ol>
		</nav>
	);
}

function segmentFill({
	current,
	seen,
	status,
}: {
	current: boolean;
	seen: boolean;
	status: ThreadStatus;
}): string {
	if (current) {
		return CURRENT[status];
	}
	// A live run keeps breathing after you pass it, so the strip agrees with
	// "still running" on the caught-up page.
	if (seen) {
		return status === "working"
			? `animate-pulse motion-reduce:animate-none ${SEEN}`
			: SEEN;
	}
	return AHEAD[status];
}

function FocusSegment({
	current,
	index,
	item,
	onSelect,
	seen,
	slim,
	tabbable,
	total,
}: {
	current: boolean;
	index: number;
	item: FocusItem;
	onSelect: (index: number) => void;
	seen: boolean;
	slim: boolean;
	tabbable: boolean;
	total: number;
}) {
	const label = `${index + 1} of ${total}: ${item.thread.title}, ${THREAD_STATUS_LABELS[item.status]}`;
	return (
		<li className="flex min-w-0.5 flex-1">
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							aria-current={current ? "step" : undefined}
							aria-label={label}
							className={cn(
								// The bar stays thin; the button (plus its ::before)
								// keeps a larger pointer target around it.
								"group/segment relative flex w-full min-w-0 cursor-pointer rounded-full outline-none before:absolute before:inset-x-0 before:content-[''] focus-visible:ring-2 focus-visible:ring-ring/50",
								slim
									? "h-3 items-end before:-top-3 before:bottom-0"
									: "h-5 items-center before:-inset-y-0.5"
							)}
							data-segment-index={index}
							onClick={() => onSelect(index)}
							tabIndex={tabbable ? 0 : -1}
							type="button"
						/>
					}
				>
					<span
						aria-hidden="true"
						className={cn(
							"block w-full rounded-full transition-[background-color,height] duration-200 ease-out motion-reduce:transition-none",
							// One height for every segment; the current one is
							// marked by fill alone.
							slim ? "h-0.5" : "h-1",
							segmentFill({ current, seen, status: item.status })
						)}
					/>
				</TooltipTrigger>
				<TooltipContent side="bottom">
					<span className="max-w-60 truncate">{item.thread.title}</span>
					<span className="text-muted-foreground tabular-nums">
						{index + 1}/{total}
					</span>
				</TooltipContent>
			</Tooltip>
		</li>
	);
}
