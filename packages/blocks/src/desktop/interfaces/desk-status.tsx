import { Badge } from "@ryu/ui/components/badge.tsx";
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

interface DeskStatusMeta {
	icon: LucideIcon;
	/** Pill surface, border and text: theme tokens only. */
	pill: string;
	/** Glyph color on its own. */
	tone: string;
}

/** How each status looks, built only from the user's theme tokens. */
const DESK_STATUS_META: Record<ThreadStatus, DeskStatusMeta> = {
	attention: {
		icon: CircleAlert,
		pill: "border-destructive/30 bg-destructive/10 text-status-destructive",
		tone: "text-status-destructive",
	},
	quiet: {
		icon: CircleDashed,
		pill: "border-border bg-transparent text-foreground/70",
		tone: "text-muted-foreground",
	},
	waiting: {
		icon: Clock,
		pill: "border-border bg-transparent text-foreground/80",
		tone: "text-muted-foreground",
	},
	working: {
		icon: LoaderCircle,
		pill: "border-success/30 bg-success/10 text-status-success",
		tone: "text-status-success",
	},
	// Tinted like every other status, so the header carries no loud badge.
	"your-turn": {
		icon: Reply,
		pill: "border-primary/30 bg-primary/10 text-primary",
		tone: "text-primary",
	},
};

/**
 * The status glyph. Static by default; only the list row mark passes `live`
 * so one spinner (motion permitting) marks a running conversation.
 */
export function DeskStatusIcon({
	className,
	live = false,
	status,
}: {
	className?: string;
	live?: boolean;
	status: ThreadStatus;
}) {
	const meta = DESK_STATUS_META[status];
	const Icon = meta.icon;
	return (
		<Icon
			aria-hidden="true"
			className={cn(
				"size-3.5 shrink-0",
				meta.tone,
				live && status === "working" && "motion-safe:animate-spin",
				className
			)}
		/>
	);
}

/**
 * The one mark a list row carries before its time, in the inbox convention:
 * an unread dot when it is the user's turn, a bare glyph for a failed run, a
 * live run or a message still waiting on its agent, and nothing when quiet.
 */
export function DeskRowMark({
	onAccent = false,
	status,
}: {
	/** Sitting on `bg-accent` (a selected row): re-tone the muted glyph. */
	onAccent?: boolean;
	status: ThreadStatus;
}) {
	if (status === "quiet") {
		return null;
	}
	if (status === "your-turn") {
		return (
			<span
				aria-hidden="true"
				className="size-2 shrink-0 rounded-full bg-primary"
				data-mark={status}
			/>
		);
	}
	return (
		<span className="flex shrink-0" data-mark={status}>
			<DeskStatusIcon
				className={cn(
					status === "waiting" && onAccent && "text-accent-foreground/70"
				)}
				live
				status={status}
			/>
		</span>
	);
}

/** Neutral statuses re-toned for the accent surface of the header. */
const ON_ACCENT_PILL =
	"border-accent-foreground/25 bg-transparent text-accent-foreground/80";

/** The status pill in the conversation header. */
export function DeskStatusPill({
	className,
	onAccent = false,
	status,
}: {
	className?: string;
	/** Sitting on `bg-accent` (a selected row): keep neutral pills legible. */
	onAccent?: boolean;
	status: ThreadStatus;
}) {
	const meta = DESK_STATUS_META[status];
	const Icon = meta.icon;
	const neutral = status === "waiting" || status === "quiet";
	return (
		<Badge
			className={cn(
				"shrink-0 gap-1",
				onAccent && neutral ? ON_ACCENT_PILL : meta.pill,
				className
			)}
			data-status={status}
			variant="outline"
		>
			<Icon aria-hidden="true" />
			<span>{THREAD_STATUS_LABELS[status]}</span>
		</Badge>
	);
}
