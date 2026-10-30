import { Skeleton } from "@ryu/ui/components/skeleton.tsx";

const SKELETON_CELLS = Array.from(
	{ length: 42 },
	(_, index) => `cell-${index}`
);
const SKELETON_WEEKDAYS = Array.from(
	{ length: 7 },
	(_, index) => `day-${index}`
);

/** The month's own frame (rail, weekday strip, six weeks), so nothing jumps. */
export function CalendarSkeleton() {
	return (
		<div aria-hidden="true" className="flex min-h-0 flex-1">
			<div className="flex w-56 shrink-0 flex-col gap-5 px-3 pt-3 max-lg:hidden xl:w-64">
				<Skeleton className="h-12 w-36" radius="panel" />
				<Skeleton className="h-52 w-full" radius="panel" />
				<div className="flex flex-col gap-2">
					<Skeleton className="h-3 w-24" radius="dense" />
					<Skeleton className="h-9 w-full" radius="row" />
					<Skeleton className="h-9 w-full" radius="row" />
				</div>
			</div>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col border-border lg:border-l">
				<div className="grid h-9 shrink-0 grid-cols-7 items-center border-border border-b">
					{SKELETON_WEEKDAYS.map((day) => (
						<Skeleton className="mx-auto h-2.5 w-7" key={day} radius="dense" />
					))}
				</div>
				<div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
					{SKELETON_CELLS.map((cell) => (
						<div
							className="flex flex-col gap-1.5 border-border border-r border-b p-1.5 [&:nth-child(7n)]:border-r-0 [&:nth-last-child(-n+7)]:border-b-0"
							key={cell}
						>
							<Skeleton className="mx-auto h-4 w-5" radius="pill" />
							<Skeleton className="h-3.5 w-4/5" radius="dense" />
							<Skeleton className="h-3.5 w-3/5" radius="dense" />
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
