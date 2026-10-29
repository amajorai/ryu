import { Skeleton } from "@ryu/ui/components/skeleton.tsx";

/** Title widths per placeholder row, so the stack doesn't read as a grid. */
const PLACEHOLDER_ROWS = [
	{ key: "row-1", preview: "w-4/5", title: "w-3/5" },
	{ key: "row-2", preview: "w-2/3", title: "w-2/5" },
	{ key: "row-3", preview: "w-3/4", title: "w-1/2" },
	{ key: "row-4", preview: "w-3/5", title: "w-2/3" },
	{ key: "row-5", preview: "w-4/5", title: "w-2/5" },
	{ key: "row-6", preview: "w-1/2", title: "w-1/2" },
] as const;

/**
 * Loading list in the exact shape of the real rows (section header, avatar,
 * title and preview lines), so threads land without a layout jump.
 */
export function InboxSkeleton() {
	return (
		<div
			aria-busy="true"
			className="flex flex-col"
			data-testid="inbox-skeleton"
			role="status"
		>
			<span className="sr-only">Loading inbox</span>
			<div aria-hidden="true" className="flex h-8 items-center gap-3 pr-4 pl-5">
				<span className="flex w-6 shrink-0 justify-center">
					<Skeleton className="size-3.5" radius="pill" />
				</span>
				<Skeleton className="h-2.5 w-20" radius="block" />
			</div>
			{PLACEHOLDER_ROWS.map((row) => (
				<div
					aria-hidden="true"
					className="flex items-center gap-3 py-2 pr-4 pl-5"
					key={row.key}
				>
					<Skeleton className="size-6 shrink-0" radius="pill" />
					<div className="flex min-w-0 flex-1 flex-col">
						<div className="flex h-5 items-center gap-2">
							<Skeleton className={`h-3 ${row.title}`} radius="block" />
							<Skeleton className="ml-auto h-2.5 w-6" radius="block" />
						</div>
						<div className="flex h-4 items-center">
							<Skeleton className={`h-2.5 ${row.preview}`} radius="block" />
						</div>
					</div>
				</div>
			))}
		</div>
	);
}
