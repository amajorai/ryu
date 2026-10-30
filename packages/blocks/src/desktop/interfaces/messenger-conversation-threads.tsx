import { useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ChevronDown, CircleAlert, Users } from "lucide-react";
import { compactAge } from "./interface-renderer.ts";
import { fullTimestamp, type MessengerEntry } from "./messenger-model.ts";

/** Pills shown inline before the rest move into a "More" menu. */
const MAX_PILLS = 3;

const STATUS_DOT: Record<ThreadStatus, string> = {
	attention: "bg-destructive",
	quiet: "border border-muted-foreground",
	waiting: "bg-muted-foreground",
	working: "bg-success motion-safe:animate-pulse",
	"your-turn": "bg-primary",
};

function threadLabel(thread: InterfaceThread, isGroup: boolean): string {
	const status = THREAD_STATUS_LABELS[threadStatus(thread)];
	const prefix = isGroup ? "Group conversation, " : "";
	const age = compactAge(thread.updatedAt);
	let updated = "";
	if (age === "now") {
		updated = ", updated just now";
	} else if (age) {
		updated = `, updated ${age} ago`;
	}
	return `${prefix}${thread.title || "Untitled"}, ${status}${updated}`;
}

function isGroupThread(entry: MessengerEntry, thread: InterfaceThread) {
	return entry.kind === "agent" && thread.agentIds.length > 1;
}

function ThreadPill({
	active,
	entry,
	onOpen,
	thread,
}: {
	active: boolean;
	entry: MessengerEntry;
	onOpen: (threadId: string) => void;
	thread: InterfaceThread;
}) {
	const status = threadStatus(thread);
	const isGroup = isGroupThread(entry, thread);
	return (
		<li className="min-w-0 max-w-80">
			<button
				aria-current={active ? "true" : undefined}
				aria-label={threadLabel(thread, isGroup)}
				className={cn(
					"flex h-7 max-w-full items-center gap-2 rounded-md px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
					active
						? "bg-muted font-medium text-foreground"
						: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
				)}
				onClick={() => onOpen(thread.id)}
				title={`${thread.title || "Untitled"} · ${THREAD_STATUS_LABELS[status]} · ${fullTimestamp(thread.updatedAt)}`}
				type="button"
			>
				<span
					aria-hidden="true"
					className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status])}
				/>
				{isGroup ? (
					<Users aria-hidden="true" className="size-3.5 shrink-0" />
				) : null}
				<span className="truncate">{thread.title || "Untitled"}</span>
				<span
					aria-hidden="true"
					className="shrink-0 font-normal text-muted-foreground tabular-nums"
				>
					{compactAge(thread.updatedAt)}
				</span>
			</button>
		</li>
	);
}

/** Older conversations past {@link MAX_PILLS}, in a menu. */
function MoreThreads({
	entry,
	onOpen,
	threads,
}: {
	entry: MessengerEntry;
	onOpen: (threadId: string) => void;
	threads: InterfaceThread[];
}) {
	const tl = useLiteralMessages();
	return (
		<li>
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label={tl("{length} more conversations with {name}", {
						length: String(threads.length),
						name: entry.name,
					})}
					className="flex h-7 items-center gap-1 rounded-md px-2.5 text-muted-foreground text-xs outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
				>
					<span className="flex items-center gap-1 whitespace-nowrap">
						{tl("More ({length})", { length: String(threads.length) })}
						<ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
					</span>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="start"
					className="max-h-80 w-80"
					drawerLabel={tl("Conversations with {name}", { name: entry.name })}
				>
					{threads.map((thread) => {
						const status = threadStatus(thread);
						return (
							<DropdownMenuItem
								aria-label={threadLabel(thread, isGroupThread(entry, thread))}
								className="gap-2"
								key={thread.id}
								onClick={() => onOpen(thread.id)}
							>
								<span
									aria-hidden="true"
									className={cn(
										"size-2 shrink-0 rounded-full",
										STATUS_DOT[status]
									)}
								/>
								<span className="min-w-0 flex-1 truncate">
									{thread.title || "Untitled"}
								</span>
								<span
									aria-hidden="true"
									className="shrink-0 text-muted-foreground text-xs tabular-nums"
								>
									{compactAge(thread.updatedAt)}
								</span>
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuContent>
			</DropdownMenu>
		</li>
	);
}

/**
 * The contact's conversations as wrapping pills, newest first. Past
 * {@link MAX_PILLS} the rest sit in a "More" menu; the open one always
 * keeps its pill.
 */
export function ThreadSwitcher({
	activeThreadId,
	entry,
	onOpen,
	threads,
}: {
	activeThreadId: string | null;
	entry: MessengerEntry;
	onOpen: (threadId: string) => void;
	threads: InterfaceThread[];
}) {
	const tl = useLiteralMessages();
	const [only] = threads;
	// One conversation that is already open: the chat itself names it.
	if (!only || (threads.length === 1 && only.id === activeThreadId)) {
		return null;
	}
	let inline = threads;
	let overflow: InterfaceThread[] = [];
	if (threads.length > MAX_PILLS + 1) {
		inline = threads.slice(0, MAX_PILLS);
		overflow = threads.slice(MAX_PILLS);
		const active = overflow.find((thread) => thread.id === activeThreadId);
		if (active) {
			inline = [...threads.slice(0, MAX_PILLS - 1), active];
			overflow = threads.filter((thread) => !inline.includes(thread));
		}
	}
	return (
		<nav
			aria-label={tl("Conversations with {name}", { name: entry.name })}
			className="shrink-0 border-border border-b bg-background"
		>
			<ul className="flex flex-wrap items-center gap-1 px-3 py-2">
				{inline.map((thread) => (
					<ThreadPill
						active={thread.id === activeThreadId}
						entry={entry}
						key={thread.id}
						onOpen={onOpen}
						thread={thread}
					/>
				))}
				{overflow.length > 0 ? (
					<MoreThreads entry={entry} onOpen={onOpen} threads={overflow} />
				) : null}
			</ul>
		</nav>
	);
}

/** A slim notice when the open thread's last run failed or was interrupted. */
export function RunNotice({ thread }: { thread: InterfaceThread }) {
	if (threadStatus(thread) !== "attention") {
		return null;
	}
	return (
		<p
			className="flex h-8 shrink-0 items-center gap-2 border-border border-b px-4 text-destructive text-xs"
			role="status"
		>
			<CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
			{thread.runState === "interrupted"
				? "The last run was interrupted."
				: "The last run failed."}
		</p>
	);
}
