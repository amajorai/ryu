import { Button } from "@ryu/ui/components/button.tsx";
import { Plus } from "lucide-react";

/**
 * The board's whole-surface empty states: no threads at all, or filters that
 * hide every thread. A short title, one plain line, and one way forward —
 * no illustration, the way trackers keep an empty view quiet.
 */
export function BoardEmptyState({
	kind,
	onClearFilters,
	onStart,
}: {
	kind: "empty" | "no-matches";
	onClearFilters: () => void;
	onStart: () => void;
}) {
	const noMatches = kind === "no-matches";
	return (
		<section
			aria-labelledby="board-empty-title"
			className="flex flex-1 items-center justify-center p-8"
		>
			<div className="flex max-w-80 flex-col items-center gap-4 text-center">
				<div className="flex flex-col gap-1">
					<h2
						className="font-medium text-[13px] text-foreground leading-5"
						id="board-empty-title"
					>
						{noMatches ? "No threads match" : "No threads yet"}
					</h2>
					<p className="text-muted-foreground text-xs leading-[18px]">
						{noMatches
							? "No thread matches the current filters."
							: "Threads with your agents appear here, grouped by where they stand."}
					</p>
				</div>
				{noMatches ? (
					<Button
						onClick={onClearFilters}
						size="compact"
						type="button"
						variant="outline"
					>
						Clear filters
					</Button>
				) : (
					<Button
						aria-keyshortcuts="C"
						onClick={onStart}
						size="compact"
						type="button"
					>
						<Plus aria-hidden="true" data-icon="inline-start" />
						New thread
					</Button>
				)}
			</div>
		</section>
	);
}
