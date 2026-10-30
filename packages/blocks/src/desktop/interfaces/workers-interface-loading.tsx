import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { GamePlate } from "./game-hud.tsx";

export function LoadingOffice() {
	return (
		<div className="flex w-full flex-wrap content-center items-start justify-center gap-6 p-8">
			{["a", "b", "c", "d", "e", "f"].map((key) => (
				<div className="flex w-60 flex-col gap-3" key={key}>
					<Skeleton className="h-32 w-full rounded-lg" />
					<Skeleton className="h-4 w-24" />
				</div>
			))}
			<span className="sr-only">Loading the office</span>
		</div>
	);
}

/** The empty office: no agents have a desk yet. */
export function EmptyOffice() {
	return (
		<div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
			<GamePlate className="pointer-events-auto flex max-w-sm flex-col gap-1.5 px-5 py-4 text-center">
				<h2 className="gk-display text-[22px] leading-7">No workers yet</h2>
				<p className="text-pretty font-medium text-(--gk-ink-muted) text-[15px] leading-6">
					Each agent gets a desk here. Start a task and its computer lights up.
				</p>
			</GamePlate>
		</div>
	);
}
