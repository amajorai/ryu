import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfacePort,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ArrowLeft, X } from "lucide-react";
import type { ReactNode } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { STATUS_TEXT, THREAD_PANEL_WIDTH } from "./world-3d-dialog-styles.ts";
import {
	isUrgent,
	SHORT_STATUS_LABELS,
	shortStatusLabel,
} from "./world-3d-model.ts";

/**
 * Who the open conversation is with and where it stands: the agent, then
 * the thread's own status (not the agent's presence, which can differ).
 */
function ThreadSubline({
	acted = false,
	agent,
	thread,
}: {
	/** The act layer is on: no thread status word (the acts say it). */
	acted?: boolean;
	agent: InterfaceAgent;
	thread: InterfaceThread | undefined;
}) {
	const status = thread ? threadStatus(thread) : null;
	return (
		<p className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs leading-4">
			<span className="min-w-0 truncate">{agent.name}</span>
			{status && status !== "quiet" && !acted ? (
				<>
					<span aria-hidden="true">·</span>
					<span
						className={cn(
							"inline-flex shrink-0 items-center gap-1.5",
							isUrgent(status) && "font-medium",
							STATUS_TEXT[status]
						)}
					>
						{status === "working" ? <BoardStatusDot status="working" /> : null}
						{thread ? shortStatusLabel(thread) : SHORT_STATUS_LABELS[status]}
					</span>
				</>
			) : null}
		</p>
	);
}

/** The host's thread view in a panel on the right, titled by the thread. */
export function ThreadPanel({
	acted = false,
	agent,
	onClose,
	port,
	thread,
	threadView,
}: {
	acted?: boolean;
	agent: InterfaceAgent;
	onClose: () => void;
	port: InterfacePort;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	return (
		<div
			className="pointer-events-auto absolute top-0 right-0 bottom-0 flex max-w-full flex-col overflow-hidden border-border border-l bg-card text-card-foreground"
			data-testid="world-3d-thread-panel"
			style={{ width: THREAD_PANEL_WIDTH }}
		>
			{/* The back arrow's glyph lands on the thread's 16px gutter. */}
			<header className="flex h-14 shrink-0 items-center gap-1 border-border border-b px-4">
				<Button
					aria-label="Back to conversations"
					className="-ml-2"
					onClick={port.closeThread}
					size="icon-sm"
					title="Back to conversations"
					type="button"
					variant="ghost-muted"
				>
					<ArrowLeft aria-hidden="true" />
				</Button>
				<div className="flex min-w-0 flex-1 flex-col">
					<h2 className="truncate font-semibold text-foreground text-sm leading-5">
						{thread ? thread.title || "Untitled" : agent.name}
					</h2>
					<ThreadSubline acted={acted} agent={agent} thread={thread} />
				</div>
				<Button
					aria-keyshortcuts="Escape"
					aria-label="Walk away"
					className="-mr-2"
					onClick={onClose}
					size="icon-sm"
					title="Walk away (Esc)"
					type="button"
					variant="ghost-muted"
				>
					<X aria-hidden="true" />
				</Button>
			</header>
			<div className="min-h-0 flex-1 overflow-hidden bg-background text-foreground">
				{threadView}
			</div>
		</div>
	);
}
