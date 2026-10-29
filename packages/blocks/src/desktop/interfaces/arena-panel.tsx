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
import { LoaderCircle, X } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { ArenaAvatar } from "./arena-avatar.tsx";
import { agentById } from "./interface-renderer.ts";

const STATUS_TONE: Record<ThreadStatus, string> = {
	attention: "text-status-destructive",
	quiet: "text-muted-foreground",
	waiting: "text-muted-foreground",
	working: "text-foreground",
	"your-turn": "text-foreground",
};

/* The wall's words: a failed run reads "Failed" here as on its card. */
const STATUS_LABELS: Record<ThreadStatus, string> = {
	...THREAD_STATUS_LABELS,
	attention: "Failed",
};

/**
 * The open thread beside the wall: who it is with, what it is called, where it
 * stands, and a close control, over the host's real conversation surface.
 */
export function ArenaThreadPanel({
	headingRef,
	leadAgentId,
	onClose,
	snapshot,
	thread,
	threadView,
}: {
	/**
	 * Focus lands here when a thread opens from the wall, so screen readers
	 * announce the thread. It is not a control, so it draws no focus ring.
	 */
	headingRef: Ref<HTMLHeadingElement>;
	/** The agent the user opened the thread from (a shared thread's first agent otherwise). */
	leadAgentId: string | undefined;
	onClose: () => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const title = thread
		? thread.title.trim() || "Untitled thread"
		: "New thread";
	const lead = agentById(snapshot, leadAgentId);
	const others = (thread?.agentIds.length ?? 0) - 1;
	const status = thread ? threadStatus(thread) : null;
	const tl = useLiteralMessages();
	return (
		<aside
			aria-label={tl("Thread: {title}", { title })}
			className="flex min-h-0 w-[46%] min-w-90 max-w-[880px] shrink-0 flex-col border-border border-l bg-background max-md:absolute max-md:inset-0 max-md:z-20 max-md:w-full max-md:min-w-0 max-md:max-w-none max-md:border-l-0"
			data-testid="arena-thread-panel"
		>
			<header className="flex h-14 shrink-0 items-center gap-3 border-border border-b px-4">
				{lead ? <ArenaAvatar agent={lead} name={lead.name} size={28} /> : null}
				<div className="flex min-w-0 flex-1 flex-col items-start gap-1">
					<h2
						className="max-w-full truncate font-medium text-foreground text-sm leading-5 outline-none"
						ref={headingRef}
						tabIndex={-1}
					>
						{title}
					</h2>
					<p className="flex min-w-0 max-w-full items-center gap-1.5 truncate text-muted-foreground text-xs leading-4">
						<span className="truncate">
							{lead ? lead.name : "No agent assigned"}
							{others > 0 ? ` +${others}` : ""}
						</span>
						{status ? (
							<>
								<span aria-hidden="true">·</span>
								<span
									className={cn(
										"inline-flex shrink-0 items-center gap-1",
										STATUS_TONE[status]
									)}
								>
									{status === "working" ? (
										<LoaderCircle
											aria-hidden="true"
											className="size-3 text-status-success motion-safe:animate-spin"
										/>
									) : null}
									{STATUS_LABELS[status]}
								</span>
							</>
						) : null}
					</p>
				</div>
				<Button
					aria-label="Close thread"
					className="-me-1.5 size-7"
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
