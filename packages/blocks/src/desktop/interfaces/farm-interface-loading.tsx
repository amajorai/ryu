import { Skeleton } from "@ryu/ui/components/skeleton.tsx";

export function LoadingFarm() {
	return (
		<div className="flex w-full flex-wrap content-center items-start justify-center gap-6 p-8">
			{["a", "b", "c", "d", "e", "f"].map((key) => (
				<div className="flex w-60 flex-col gap-3" key={key}>
					<Skeleton className="h-32 w-full rounded-lg" />
					<Skeleton className="h-4 w-24" />
				</div>
			))}
			<span className="sr-only">Loading the farm</span>
		</div>
	);
}
