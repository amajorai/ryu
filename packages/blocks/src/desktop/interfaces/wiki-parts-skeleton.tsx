import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const LINE_WIDTHS = ["w-full", "w-11/12", "w-full", "w-4/5", "w-full", "w-2/3"];

export function WikiSkeleton() {
	return (
		<div aria-busy="true" className="pt-6" role="status">
			<span className="sr-only">Loading the wiki</span>
			<Skeleton className="h-8 w-72" radius="block" />
			<div className="mt-2 h-px bg-border" />
			<div className="mt-3 flex justify-between">
				<div className="flex gap-4">
					<Skeleton className="h-4 w-14" radius="block" />
					<Skeleton className="h-4 w-10" radius="block" />
				</div>
				<div className="flex gap-4">
					<Skeleton className="h-4 w-10" radius="block" />
					<Skeleton className="h-4 w-24" radius="block" />
				</div>
			</div>
			<div className="mt-6 flex gap-6">
				<div className="flex flex-1 flex-col gap-3">
					{LINE_WIDTHS.map((width, index) => (
						<Skeleton
							className={cn("h-3.5", width)}
							key={`line-${width}-${String(index)}`}
							radius="block"
						/>
					))}
				</div>
				<Skeleton
					className="@2xl/article:block hidden h-72 w-72 shrink-0"
					radius="block"
				/>
			</div>
		</div>
	);
}
