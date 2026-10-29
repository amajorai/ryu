import { cn } from "@ryu/ui/lib/utils";
import {
	THREAD_STATUS_LABELS,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";

const DOT: Record<ThreadStatus, string> = {
	attention: "bg-destructive",
	quiet: "border border-muted-foreground/70 border-dashed",
	waiting: "border-[1.5px] border-muted-foreground/70",
	// A hollow ring (not a dot) so "working" never reads as "your turn" in themes
	// where the primary accent and the success token are both green.
	working: "border-2 border-success",
	"your-turn": "bg-primary",
};

/**
 * The one status mark the Board uses on column headers, cards, and the panel.
 * Each status differs by shape as well as color: a solid destructive dot for
 * failures, a solid primary dot for "your turn", a success ring (with a
 * pulsing halo unless `pulse` is false) for live runs, and muted outlines
 * (solid or dashed) for waiting/quiet. The Board itself passes `pulse={false}`:
 * the ring alone says "working" there, and nothing on the board moves.
 */
export function BoardStatusDot({
	className,
	pulse = true,
	status,
}: {
	className?: string;
	pulse?: boolean;
	status: ThreadStatus;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative inline-block size-2 shrink-0 rounded-full",
				DOT[status],
				className
			)}
		>
			{status === "working" && pulse ? (
				<span className="absolute -inset-0.75 rounded-full bg-success/25 motion-safe:animate-pulse" />
			) : null}
		</span>
	);
}

/** A compact dot + label for places where the column does not already say it. */
export function BoardStatusLabel({
	pulse = true,
	status,
}: {
	pulse?: boolean;
	status: ThreadStatus;
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 font-medium text-xs",
				status === "attention" && "text-destructive",
				status === "your-turn" && "text-primary",
				(status === "waiting" || status === "quiet") && "text-muted-foreground"
			)}
		>
			<BoardStatusDot pulse={pulse} status={status} />
			{THREAD_STATUS_LABELS[status]}
		</span>
	);
}

/** What an empty status column says, in the user's terms. */
export const BOARD_STATUS_EMPTY: Record<ThreadStatus, string> = {
	attention: "No failed runs",
	quiet: "No unstarted threads",
	waiting: "Nothing waiting on an agent",
	working: "No agents working",
	"your-turn": "Nothing needs you",
};
