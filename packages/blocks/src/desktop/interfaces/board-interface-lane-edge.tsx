import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * A slim, always-visible strip on the board's edge while lanes sit off that
 * side: a chevron over how many are hidden, so the urgent lanes never vanish
 * without a trace when a thread is open. Clicking steps one lane; arrow keys
 * already reach every lane, so it stays out of the Tab order.
 */
export function LaneEdge({
	count,
	onStep,
	side,
}: {
	count: number;
	onStep: () => void;
	side: "end" | "start";
}) {
	const Icon = side === "start" ? ChevronLeft : ChevronRight;
	const tl = useLiteralMessages();
	const label =
		side === "start"
			? tl(
					"{count, plural, one {Show # earlier lane} other {Show # earlier lanes}}",
					{ count }
				)
			: tl(
					"{count, plural, one {Show # later lane} other {Show # later lanes}}",
					{ count }
				);
	return (
		<button
			aria-label={label}
			className={cn(
				"flex w-8 shrink-0 flex-col items-center border-border bg-background pt-4 text-muted-foreground outline-none transition-colors duration-100 hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
				side === "start" ? "border-e" : "border-s"
			)}
			data-board-edge={side}
			onClick={onStep}
			tabIndex={-1}
			title={label}
			type="button"
		>
			<span className="flex h-11 flex-col items-center justify-center gap-0.5">
				<Icon aria-hidden="true" className="size-4" />
				<span className="text-xs tabular-nums leading-4">{count}</span>
			</span>
		</button>
	);
}
