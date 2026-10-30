import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import { notebookRunTime } from "./notebook-model.ts";

export function SectionHeading({
	action,
	children,
	icon,
	id,
}: {
	/** A quiet text action at the right end, e.g. "Show all". */
	action?: ReactNode;
	children: string;
	icon: ReactNode;
	id: string;
}) {
	return (
		<div className="mb-2 flex h-6 items-center gap-2">
			<h2
				className="flex min-w-0 flex-1 items-center gap-1.5 font-medium text-muted-foreground text-xs [&_svg]:size-3.5 [&_svg]:shrink-0"
				id={id}
			>
				{icon}
				{children}
			</h2>
			{action}
		</div>
	);
}

/** The most rows either Home list shows before "Show all". */
export const HOME_LIST_LIMIT = 5;

/**
 * Needs you shows as many rows as Upcoming runs (3 to 5), so the two cards
 * share a bottom edge with no blank rows; with no runs ahead it shows five.
 */
export function needsYouLimit(upcomingCount: number): number {
	if (upcomingCount === 0) {
		return HOME_LIST_LIMIT;
	}
	return Math.min(HOME_LIST_LIMIT, Math.max(3, upcomingCount));
}

/** One height for every Home list row, so both cards rule up line by line. */
const LIST_ROW = "h-13";

export function RunTime({ iso, now }: { iso: string; now: number }) {
	const { day, time } = notebookRunTime(iso, now);
	return (
		<time
			className="flex w-24 shrink-0 flex-col text-xs leading-4"
			dateTime={iso}
		>
			<span className="truncate font-medium text-foreground">{day}</span>
			<span className="truncate text-muted-foreground tabular-nums">
				{time ?? "\u00a0"}
			</span>
		</time>
	);
}

/**
 * One row treatment for both Home lists: a padded row that highlights on
 * hover when it opens a page, and stays still when it is information only.
 */
export const LIST_ROW_PAD = cn(
	"flex w-full items-center gap-3 rounded-md px-2 text-left",
	LIST_ROW
);

export function ListCard({
	children,
	empty,
	labelledBy,
}: {
	children: ReactNode[];
	empty: string;
	labelledBy: string;
}) {
	return (
		<div className="flex-1 overflow-hidden rounded-lg bg-card p-1 ring-1 ring-border/70 dark:ring-border/50">
			{children.length > 0 ? (
				<ul aria-labelledby={labelledBy} className="flex flex-col gap-px">
					{children}
				</ul>
			) : (
				<p className="px-3 py-4 text-muted-foreground text-sm">{empty}</p>
			)}
		</div>
	);
}
