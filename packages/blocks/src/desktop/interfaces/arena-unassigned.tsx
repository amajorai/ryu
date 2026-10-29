import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ChevronRight } from "lucide-react";
import { compactAge } from "./interface-renderer.ts";

/* The status word carries the tone; failed and live rows stand out by colour too. */
const STATUS_TONE: Record<ThreadStatus, string> = {
	attention: "text-status-destructive",
	quiet: "text-muted-foreground",
	waiting: "text-muted-foreground",
	working: "text-status-success",
	"your-turn": "text-foreground",
};

/*
 * With no agent on the thread, "Waiting on agent" would name someone who is
 * not there; say what is true instead.
 */
const UNASSIGNED_LABELS: Record<ThreadStatus, string> = {
	...THREAD_STATUS_LABELS,
	attention: "Failed",
	waiting: "You wrote last",
};

/**
 * Threads with no agent on them. They count in the header's thread total, so
 * the wall lists them under the cards, each row opening its thread, rather
 * than leaving them unreachable.
 */
export function ArenaUnassigned({
	activeThreadId,
	now,
	onOpen,
	threads,
}: {
	activeThreadId: string | null;
	now: number;
	onOpen: (threadId: string) => void;
	threads: readonly InterfaceThread[];
}) {
	const tl = useLiteralMessages();
	if (threads.length === 0) {
		return null;
	}
	const headingId = "arena-unassigned-heading";
	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-2">
			<h2
				className="flex items-baseline gap-2 text-sm leading-5"
				id={headingId}
			>
				<span className="font-semibold text-foreground">Unassigned</span>
				<span className="font-normal text-muted-foreground tabular-nums">
					{threads.length}
				</span>
			</h2>
			<ul className="-mx-2 flex flex-col">
				{threads.map((thread) => {
					const status = threadStatus(thread);
					const title = thread.title.trim() || "Untitled thread";
					const age = compactAge(thread.updatedAt, now);
					const open = thread.id === activeThreadId;
					const rowClass =
						"flex h-10 w-full min-w-0 items-center gap-3 rounded-md px-2 text-start";
					const content = (
						<>
							<span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm leading-5">
								{title}
							</span>
							<span className="shrink-0 text-[13px] leading-4">
								<span className={STATUS_TONE[status]}>
									{UNASSIGNED_LABELS[status]}
								</span>
								{age ? (
									<span className="text-muted-foreground max-sm:hidden">
										{` · ${age === "now" ? "just now" : `${age} ago`}`}
									</span>
								) : null}
							</span>
						</>
					);
					return (
						<li aria-current={open ? "true" : undefined} key={thread.id}>
							{open ? (
								<div className={cn(rowClass, "bg-muted")}>{content}</div>
							) : (
								<button
									aria-label={tl("Open {title}", { title })}
									className={cn(
										rowClass,
										"group/row outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
									)}
									data-thread-id={thread.id}
									onClick={() => onOpen(thread.id)}
									type="button"
								>
									{content}
									<ChevronRight
										aria-hidden="true"
										className="-me-0.5 size-4 shrink-0 text-muted-foreground transition-colors group-hover/row:text-foreground"
									/>
								</button>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
