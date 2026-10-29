import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { dayHeading, fullDateTime, timeOfDay } from "./timeline-model.ts";
import {
	TimelineThreadAvatar,
	threadAgents,
	threadGroupName,
	threadTitle,
} from "./timeline-parts.tsx";
import { TimelineStatusDot, timelineStatusTone } from "./timeline-status.tsx";

/**
 * The open thread beside the timeline: who, what, when, and where it stands,
 * over the host's real conversation surface, which fills the rest.
 */
export function TimelineThreadPanel({
	now,
	onClose,
	snapshot,
	thread,
	threadView,
}: {
	/** The timeline's shared clock, so "Today" here matches the list. */
	now: Date;
	onClose: () => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const title = thread ? threadTitle(thread) : "New thread";
	const agents = thread ? threadAgents(snapshot, thread) : [];
	const group = thread ? threadGroupName(snapshot, thread) : null;
	const status = thread ? threadStatus(thread) : "quiet";
	return (
		<aside
			aria-label={tl("Thread: {title}", { title })}
			className="flex min-h-0 w-[46%] min-w-90 max-w-[880px] shrink-0 flex-col border-border border-l bg-background max-md:absolute max-md:inset-0 max-md:z-30 max-md:w-full max-md:min-w-0 max-md:max-w-none max-md:border-l-0"
			data-testid="timeline-thread-panel"
		>
			<header
				className="flex h-14 shrink-0 items-center gap-3 border-border border-b pr-2 pl-4"
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						onClose();
					}
				}}
			>
				<TimelineThreadAvatar agents={agents} size={28} />
				<div className="flex min-w-0 flex-1 flex-col">
					<h2 className="truncate font-medium text-sm leading-5">{title}</h2>
					{thread ? (
						<p className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs leading-4">
							<TimelineStatusDot status={status} />
							<span className="min-w-0 truncate">
								<span
									className={cn(
										"font-medium",
										timelineStatusTone(status) ?? "text-foreground"
									)}
								>
									{THREAD_STATUS_LABELS[status]}
								</span>
								{" · "}
								<time
									dateTime={thread.updatedAt}
									title={fullDateTime(thread.updatedAt)}
								>
									{dayHeading(localDayKey(new Date(thread.updatedAt)), now)},{" "}
									{timeOfDay(thread.updatedAt)}
								</time>
								{group ? ` · ${group}` : ""}
							</span>
						</p>
					) : null}
				</div>
				<Button
					aria-label="Close thread"
					onClick={onClose}
					size="icon-sm"
					title="Close thread (Esc)"
					type="button"
					variant="ghost"
				>
					<X aria-hidden="true" />
				</Button>
			</header>
			<div className="min-h-0 flex-1">{threadView}</div>
		</aside>
	);
}
