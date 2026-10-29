import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { CalendarSearch, X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { compactTime, displayWallDate, mediumDay } from "./calendar-model.ts";
import {
	CalendarStatusDot,
	threadAgents,
	threadGroupName,
	threadTitle,
} from "./calendar-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

/** The thread's status in words, with the calendar's own mark. */
function StatusLabel({ status }: { status: ThreadStatus }) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 font-medium",
				status === "attention" && "text-status-destructive",
				(status === "your-turn" || status === "working") && "text-foreground"
			)}
		>
			<CalendarStatusDot status={status} />
			{THREAD_STATUS_LABELS[status]}
		</span>
	);
}

/**
 * The open thread beside the calendar: who, when, and where it stands, over
 * the host's real conversation surface, which fills the rest.
 */
export function CalendarThreadPanel({
	onClose,
	onShowDay,
	snapshot,
	thread,
	threadView,
}: {
	onClose: () => void;
	/** Jump the calendar to the day this thread sits on. */
	onShowDay: (() => void) | null;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const title = thread ? threadTitle(thread) : "New thread";
	const agents = thread ? threadAgents(snapshot, thread) : [];
	const group = thread ? threadGroupName(snapshot, thread) : null;
	const updatedMs = thread ? Date.parse(thread.updatedAt) : Number.NaN;
	const validUpdated = Number.isNaN(updatedMs)
		? null
		: displayWallDate(updatedMs);
	return (
		<motion.aside
			animate={{ opacity: 1, x: 0 }}
			aria-label={tl("Thread: {title}", { title })}
			className={cn(
				"relative flex min-h-0 w-[clamp(360px,36%,560px)] shrink-0 flex-col border-border border-l bg-background",
				// Below 1100px the panel slides over the calendar instead of
				// squeezing it, so the grid keeps its titles; a phone gets the
				// whole width.
				"max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:end-0 max-[1100px]:z-30 max-[1100px]:w-[min(26rem,100%)] max-[1100px]:shadow-xl",
				"max-md:w-full max-md:border-l-0 max-md:shadow-none"
			)}
			data-calendar-panel=""
			data-testid="calendar-thread-panel"
			exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 24 }}
			initial={reduceMotion ? false : { opacity: 0, x: 24 }}
			transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
		>
			<header className="flex h-14 shrink-0 items-center gap-1 border-border border-b ps-4 pe-3">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5 pe-2">
					<h2 className="truncate font-heading font-semibold text-foreground text-sm leading-tight">
						{title}
					</h2>
					{thread ? (
						<p className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs leading-tight">
							<span className="shrink-0 whitespace-nowrap">
								<StatusLabel status={threadStatus(thread)} />
							</span>
							<span aria-hidden="true">·</span>
							<span className="truncate">
								{agents.length > 0
									? agents.map((agent) => agent.name).join(", ")
									: "No agent"}
								{group ? ` · ${group}` : ""}
								{validUpdated
									? ` · ${mediumDay(validUpdated)}, ${compactTime(validUpdated)}`
									: ""}
							</span>
						</p>
					) : null}
				</div>
				{onShowDay ? (
					<Button
						aria-label="Show this day in the calendar"
						onClick={onShowDay}
						size="icon-sm"
						title="Show this day"
						type="button"
						variant="ghost-muted"
					>
						<CalendarSearch aria-hidden="true" />
					</Button>
				) : null}
				<Button
					aria-label="Close thread"
					onClick={onClose}
					size="icon-sm"
					title="Close thread (Esc)"
					type="button"
					variant="ghost-muted"
				>
					<X aria-hidden="true" />
				</Button>
			</header>
			<div className="min-h-0 flex-1">{threadView}</div>
		</motion.aside>
	);
}
