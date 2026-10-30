import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { localDayKey } from "@ryuhq/protocol/interfaces";
import { Plus } from "lucide-react";
import {
	TIMELINE_DAY_ROW_GRID,
	TIMELINE_RAIL_LINE,
	TimelineDayHeadingRow,
} from "./timeline-day.tsx";
import { weekColumnLabel } from "./timeline-model.ts";
import { TimelineStatusDot } from "./timeline-status.tsx";

function RailLine() {
	return <span className={TIMELINE_RAIL_LINE} />;
}

const SKELETON_ROWS = [
	{ excerpt: "w-4/5", key: "one", title: "w-2/5" },
	{ excerpt: "w-3/5", key: "two", title: "w-1/3" },
	{ excerpt: "w-2/3", key: "three", title: "w-1/2" },
	{ excerpt: "w-3/4", key: "four", title: "w-2/5" },
	{ excerpt: "w-1/2", key: "five", title: "w-1/3" },
] as const;

/** The day rail's shape while threads load: same grid, rail and heading. */
export function DayListSkeleton() {
	return (
		<div className="flex w-full max-w-3xl flex-col">
			<div className="px-2">
				<TimelineDayHeadingRow first>
					<Skeleton className="h-3.5 w-28" radius="dense" />
				</TimelineDayHeadingRow>
			</div>
			<div className="flex flex-col px-2">
				{SKELETON_ROWS.map((row) => (
					<div className={TIMELINE_DAY_ROW_GRID} key={row.key}>
						<div className="flex justify-end pt-3.5 max-sm:hidden">
							<Skeleton className="h-2.5 w-12" radius="dense" />
						</div>
						<div className="relative flex justify-center">
							<RailLine />
							<span className="relative mt-2 flex size-5 items-center justify-center bg-background">
								<Skeleton className="size-2.5" radius="pill" />
							</span>
						</div>
						<div className="flex gap-3 px-3 py-2">
							<Skeleton className="size-5 shrink-0" radius="pill" />
							<div className="flex flex-1 flex-col gap-2 pt-1 pb-1.5">
								<Skeleton className={cn("h-3", row.title)} radius="dense" />
								<Skeleton className="h-2.5 w-1/4" radius="dense" />
								<Skeleton className={cn("h-3", row.excerpt)} radius="dense" />
							</div>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

/**
 * No threads yet: the day rail itself, empty, with one quiet mark where the
 * first thread will land and a way to start it.
 */
export function TimelineEmptyRail({
	now,
	onStart,
}: {
	now: Date;
	onStart: () => void;
}) {
	return (
		<div className="flex w-full max-w-3xl flex-col">
			<div className="px-2">
				<TimelineDayHeadingRow first>
					<h2 className="font-medium text-sm leading-5">Today</h2>
					<span className="text-muted-foreground text-xs leading-5">
						{weekColumnLabel(localDayKey(now)).full}
					</span>
				</TimelineDayHeadingRow>
			</div>
			<div className="px-2">
				<div className={TIMELINE_DAY_ROW_GRID}>
					<span aria-hidden="true" className="max-sm:hidden" />
					<span aria-hidden="true" className="relative flex justify-center">
						<span className="absolute top-0 bottom-1/2 w-px bg-border" />
						<span className="relative mt-2 flex size-5 items-center justify-center bg-background">
							<TimelineStatusDot status="quiet" />
						</span>
					</span>
					<div className="flex min-w-0 flex-col items-start px-3 py-2">
						<p className="font-medium text-sm leading-5">No threads yet</p>
						<p className="text-muted-foreground text-xs leading-5">
							Threads show up here by their latest activity.
						</p>
						<Button
							className="mt-2 -ml-2 h-7 rounded-md px-2 text-xs"
							onClick={onStart}
							size="sm"
							type="button"
							variant="ghost"
						>
							<Plus aria-hidden="true" data-icon="inline-start" />
							New thread
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
