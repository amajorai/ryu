import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { Plus } from "lucide-react";

const TILE_KEYS = ["a", "b", "c", "d", "e", "f"] as const;
const ROW_KEYS = ["a", "b", "c", "d", "e", "f", "g"] as const;

/** Rail rows in their real shape while the first load settles. */
export function LiveRailSkeleton({ collapsed }: { collapsed: boolean }) {
	return (
		<div
			aria-hidden="true"
			className={
				collapsed
					? "flex h-full w-14 shrink-0 flex-col items-center gap-3 border-sidebar-border border-r bg-sidebar pt-14"
					: "flex h-full w-60 shrink-0 flex-col gap-3 border-sidebar-border border-r bg-sidebar px-3 pt-14"
			}
		>
			{ROW_KEYS.map((key) => (
				<div className="flex items-center gap-3" key={key}>
					<Skeleton className="size-8 shrink-0 rounded-full" />
					{collapsed ? null : (
						<div className="flex flex-1 flex-col gap-1.5">
							<Skeleton className="h-3 w-20" />
							<Skeleton className="h-2.5 w-32" />
						</div>
					)}
				</div>
			))}
		</div>
	);
}

/** The Browse directory in its real shape while the first load settles. */
export function LiveBrowseSkeleton({ gutter }: { gutter: number }) {
	return (
		<div
			aria-hidden="true"
			className="flex flex-col pt-8"
			style={{ paddingInline: gutter }}
		>
			<Skeleton className="h-10 w-40" />
			<div className="mt-6 flex gap-6">
				<Skeleton className="h-6 w-20" />
				<Skeleton className="h-6 w-24" />
			</div>
			<Skeleton className="mt-8 h-7 w-36" />
			<div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-x-4 gap-y-8">
				{TILE_KEYS.map((key) => (
					<div className="flex flex-col gap-3" key={key}>
						<Skeleton className="aspect-video w-full rounded-none" />
						<div className="flex gap-3">
							<Skeleton className="size-10 shrink-0 rounded-full" />
							<div className="flex flex-1 flex-col gap-2 pt-1">
								<Skeleton className="h-3.5 w-4/5" />
								<Skeleton className="h-3 w-1/3" />
								<Skeleton className="h-3 w-1/2" />
							</div>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

/** No agents and no threads yet. */
export function LiveEmpty({
	gutter,
	onNew,
}: {
	gutter: number;
	onNew: () => void;
}) {
	return (
		<div
			className="flex min-h-full flex-col items-start justify-center pt-8 pb-16"
			style={{ paddingInline: gutter }}
		>
			<h1 className="text-4xl text-foreground leading-10 tracking-tight">
				<span className="font-bold">Browse</span>
			</h1>
			<div className="mt-12 flex w-full max-w-md flex-col gap-2">
				<h2 className="text-foreground text-lg leading-7">
					<span className="font-semibold">No channels yet</span>
				</h2>
				<p className="text-muted-foreground text-sm leading-6">
					Each agent gets a channel here. A thread an agent is running shows as
					its live stream, and its past threads become videos.
				</p>
				<div className="mt-4">
					<Button onClick={onNew} size="sm" type="button">
						<Plus
							aria-hidden="true"
							className="size-4"
							data-icon="inline-start"
						/>
						New thread
					</Button>
				</div>
			</div>
		</div>
	);
}
