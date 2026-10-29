import { cn } from "@ryu/ui/lib/utils";
import {
	THREAD_STATUS_LABELS,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	CircleAlert,
	CircleDashed,
	Clock,
	LoaderCircle,
	type LucideIcon,
	Reply,
} from "lucide-react";

interface InboxStatusMeta {
	/** Unread-style emphasis: the user is the one who should act. */
	emphasized: boolean;
	icon: LucideIcon;
	/** Theme token classes for the status glyph. */
	tone: string;
}

/** How each triage status looks, using only the user's theme tokens. */
export const INBOX_STATUS_META: Record<ThreadStatus, InboxStatusMeta> = {
	attention: {
		emphasized: true,
		icon: CircleAlert,
		tone: "text-status-destructive",
	},
	quiet: {
		emphasized: false,
		icon: CircleDashed,
		tone: "text-muted-foreground",
	},
	waiting: {
		emphasized: false,
		icon: Clock,
		tone: "text-muted-foreground",
	},
	working: {
		emphasized: false,
		icon: LoaderCircle,
		tone: "text-status-success",
	},
	"your-turn": { emphasized: true, icon: Reply, tone: "text-primary" },
};

/**
 * The status glyph; spins (motion permitting) while a run is live. Threads
 * with no agent get a neutral dashed glyph, since no agent work is pending.
 */
export function InboxStatusIcon({
	className,
	animate = false,
	status,
	unassigned = false,
}: {
	animate?: boolean;
	className?: string;
	status: ThreadStatus;
	unassigned?: boolean;
}) {
	const meta = INBOX_STATUS_META[status];
	const Icon = unassigned ? CircleDashed : meta.icon;
	return (
		<Icon
			aria-hidden="true"
			className={cn(
				"size-4 shrink-0",
				unassigned ? "text-muted-foreground" : meta.tone,
				animate && status === "working" && "motion-safe:animate-spin",
				className
			)}
		/>
	);
}

/** Spoken/visible status label; unassigned threads say so instead. */
export function inboxStatusLabel(
	status: ThreadStatus,
	unassigned = false
): string {
	return unassigned ? "Unassigned" : THREAD_STATUS_LABELS[status];
}

/**
 * The open thread's status in its header: glyph plus plain text, no pill.
 * The list's section already names it, so this stays quiet.
 */
export function InboxStatusChip({
	className,
	status,
	unassigned = false,
}: {
	className?: string;
	status: ThreadStatus;
	unassigned?: boolean;
}) {
	return (
		<span
			className={cn(
				"flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs",
				className
			)}
			data-status={status}
		>
			<InboxStatusIcon
				animate
				className="size-3.5"
				status={status}
				unassigned={unassigned}
			/>
			<span>{inboxStatusLabel(status, unassigned)}</span>
		</span>
	);
}
