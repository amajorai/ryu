import { Skeleton } from "@ryu/ui/components/skeleton.tsx";

export function GraphLoading() {
	return (
		<div
			aria-busy="true"
			aria-label="Loading the map"
			className="relative flex size-full items-center justify-center bg-background"
			data-testid="interface-graph"
			role="status"
		>
			<div aria-hidden="true" className="relative size-80">
				<Skeleton className="absolute top-1/2 left-1/2 size-24 -translate-x-1/2 -translate-y-1/2 rounded-full" />
				{[0, 1, 2, 3, 4, 5].map((index) => {
					const angle = (index / 6) * Math.PI * 2 - Math.PI / 2;
					return (
						<Skeleton
							className="absolute size-12 -translate-x-1/2 -translate-y-1/2 rounded-full"
							key={index}
							style={{
								left: `${50 + Math.cos(angle) * 40}%`,
								top: `${50 + Math.sin(angle) * 40}%`,
							}}
						/>
					);
				})}
			</div>
			<span className="sr-only">Loading the map…</span>
		</div>
	);
}
