import { cn } from "@ryu/ui/lib/utils";
import {
	THREAD_STATUS_LABELS,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Status marks for the Timeline, from the user's theme only. Colour is kept
 * for the two states that ask something of the user: a failure (destructive)
 * and "your turn" (primary). A live run is neutral and told apart by its
 * spinner shape, so it never blurs with "your turn" in themes whose primary
 * sits close to green. Waiting and not-started threads are quiet outlines.
 *
 * Every mark is drawn in the same 12px box with the same 1.5px stroke, so the
 * rail's marks line up optically whatever the status.
 */
const MARK_BOX = 12;
const MARK_CENTER = MARK_BOX / 2;
const MARK_STROKE = 1.5;
/** Outline marks: 10.5px across, outer edge included. */
const RING_RADIUS = 4.5;
/** Filled marks read larger than outlines: drawn a touch smaller. */
const FILL_RADIUS = 4.5;

const MARK_TONE: Record<ThreadStatus, string> = {
	attention: "text-destructive",
	quiet: "text-muted-foreground/70",
	waiting: "text-muted-foreground",
	working: "text-foreground/80",
	"your-turn": "text-primary",
};

/** The status bar inside a week-grid chip, so status reads even when narrow. */
export const TIMELINE_STATUS_BAR: Record<ThreadStatus, string> = {
	attention: "bg-destructive",
	quiet: "bg-muted-foreground/30",
	waiting: "bg-muted-foreground/60",
	working: "bg-foreground/70",
	"your-turn": "bg-primary",
};

/** Statuses that ask something of the user, named in words in a row's meta line. */
const CALLOUT_TONE: Partial<Record<ThreadStatus, string>> = {
	attention: "text-status-destructive",
	"your-turn": "text-foreground",
};

function MarkShape({ status }: { status: ThreadStatus }) {
	const ring = {
		cx: MARK_CENTER,
		cy: MARK_CENTER,
		fill: "none",
		r: RING_RADIUS,
		stroke: "currentColor",
		strokeWidth: MARK_STROKE,
	};
	switch (status) {
		case "attention":
			return (
				<circle
					cx={MARK_CENTER}
					cy={MARK_CENTER}
					fill="currentColor"
					r={FILL_RADIUS}
				/>
			);
		case "your-turn":
			return (
				<>
					<circle {...ring} />
					<circle cx={MARK_CENTER} cy={MARK_CENTER} fill="currentColor" r={2} />
				</>
			);
		case "working":
			// Three quarters of a ring: the spin says "live" in shape, not colour.
			return (
				<circle
					{...ring}
					strokeDasharray={`${Math.PI * RING_RADIUS * 1.5} ${Math.PI * RING_RADIUS * 2}`}
					strokeLinecap="round"
				/>
			);
		case "quiet":
			return <circle {...ring} strokeDasharray="2 1.53" />;
		default:
			return <circle {...ring} />;
	}
}

/**
 * The rail mark. Each status has its own shape, so none depends on colour or
 * motion alone: a live run is a spinner, "your turn" a ring with a filled
 * centre, a failure a solid dot, waiting a hollow ring, not started dashed.
 */
export function TimelineStatusDot({
	className,
	status,
}: {
	className?: string;
	status: ThreadStatus;
}) {
	return (
		<svg
			aria-hidden="true"
			className={cn(
				"size-3 shrink-0",
				MARK_TONE[status],
				status === "working" && "motion-safe:animate-spin",
				className
			)}
			data-status={status}
			viewBox={`0 0 ${MARK_BOX} ${MARK_BOX}`}
		>
			<MarkShape status={status} />
		</svg>
	);
}

/**
 * The status in plain words, only for the states that need the user ("Needs
 * attention", "Your turn"); the rest are said by the rail mark alone.
 */
export function TimelineStatusCallout({
	className,
	status,
}: {
	className?: string;
	status: ThreadStatus;
}) {
	const tone = CALLOUT_TONE[status];
	if (!tone) {
		return null;
	}
	return (
		<span className={cn("font-medium", tone, className)} data-status={status}>
			{THREAD_STATUS_LABELS[status]}
		</span>
	);
}

/** The status in plain words, with its tone when it asks something of the user. */
export function timelineStatusTone(status: ThreadStatus): string | undefined {
	return CALLOUT_TONE[status];
}
