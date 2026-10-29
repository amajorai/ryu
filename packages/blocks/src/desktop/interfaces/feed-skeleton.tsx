import { Skeleton } from "@ryu/ui/components/skeleton.tsx";

const SKELETON_ROWS = ["row-1", "row-2", "row-3", "row-4"] as const;

/**
 * Post-shaped placeholders while the snapshot loads: the same avatar gutter,
 * padding and divider as a real post, so nothing shifts when posts arrive.
 */
export function FeedSkeleton() {
	return (
		<div aria-label="Loading posts" role="status">
			{SKELETON_ROWS.map((rowId) => (
				<div
					className="flex gap-3 border-border border-b px-4 py-3"
					data-feed-skeleton=""
					key={rowId}
				>
					<Skeleton className="size-10 shrink-0" radius="pill" />
					<div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
						<Skeleton className="h-3.5 w-2/5" radius="pill" />
						<Skeleton className="h-3.5 w-4/5" radius="pill" />
						<Skeleton className="mt-1 h-3.5 w-full" radius="pill" />
						<Skeleton className="h-3.5 w-3/5" radius="pill" />
						<div className="mt-2 flex gap-12">
							<Skeleton className="size-[18px]" radius="pill" />
							<Skeleton className="size-[18px]" radius="pill" />
						</div>
					</div>
				</div>
			))}
		</div>
	);
}
