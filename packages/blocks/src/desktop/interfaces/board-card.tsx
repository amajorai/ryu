import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { Folder, MessageSquare, Pin, Users } from "lucide-react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusDot } from "./board-status.tsx";
import { compactAge } from "./interface-renderer.ts";

/** Attribute the board's arrow-key navigation looks for. */
export const BOARD_CARD_ATTRIBUTE = "data-board-card";

/** Faces shown on a card before the rest collapse into `+n`. */
const FACE_LIMIT = 3;

/** One icon size and stroke for every glyph on a card. */
const META_ICON = "size-3.5 shrink-0";

function failureLabel(thread: InterfaceThread): string {
	return thread.runState === "interrupted"
		? "Run interrupted"
		: "Last run failed";
}

/**
 * Participants as overlapping faces only — the names are announced, not
 * printed, the way a tracker shows assignees on a card.
 */
function CardFaces({ agents }: { agents: InterfaceAgent[] }) {
	const tl = useLiteralMessages();
	if (agents.length === 0) {
		return (
			<span className="flex items-center">
				<span
					aria-hidden="true"
					className="size-5 rounded-full border border-muted-foreground/50 border-dashed"
				/>
				<span className="sr-only">No agent assigned</span>
			</span>
		);
	}
	const shown = agents.slice(0, FACE_LIMIT);
	const extra = agents.length - shown.length;
	const names = agents.map((agent) => agent.name).join(", ");
	return (
		<span className="flex min-w-0 items-center" title={names}>
			<span aria-hidden="true" className="flex shrink-0 -space-x-1">
				{shown.map((agent) => (
					<BoardAvatar
						agent={agent}
						className="ring-2 ring-card"
						key={agent.id}
						name={agent.name}
						size={20}
					/>
				))}
				{extra > 0 ? (
					<span className="z-10 flex size-5 items-center justify-center rounded-full bg-muted font-medium text-[11px] text-muted-foreground ring-2 ring-card">
						+{extra}
					</span>
				) : null}
			</span>
			<span className="sr-only">{tl("With {names}", { names })}</span>
		</span>
	);
}

/**
 * One thread as a compact Kanban card. The title is the card's single
 * interactive element; its hit area stretches over the whole card so any click
 * opens the thread, while screen readers hear one button named by the title.
 */
export function BoardCard({
	agents,
	columnIndex,
	group,
	now,
	onOpen,
	rowIndex,
	selected,
	showStatus,
	tabStop,
	thread,
}: {
	agents: InterfaceAgent[];
	columnIndex: number;
	group: InterfaceGroup | undefined;
	now: number;
	onOpen: (threadId: string) => void;
	rowIndex: number;
	selected: boolean;
	/** Show the status on the card (when the column does not already say it). */
	showStatus: boolean;
	/** Whether this card is the board's single Tab stop (roving tabindex). */
	tabStop: boolean;
	thread: InterfaceThread;
}) {
	const status = threadStatus(thread);
	const failed = status === "attention";
	const age = compactAge(thread.updatedAt, now);
	const title = thread.title.trim() || "Untitled thread";
	const excerptId = `board-card-excerpt-${thread.id}`;
	return (
		<article
			className={cn(
				"relative flex flex-col gap-3 rounded-lg border border-border bg-card px-3.5 py-3 text-card-foreground shadow-xs transition-[border-color,box-shadow] duration-100 hover:border-foreground/20 hover:shadow-sm motion-reduce:transition-none",
				// Selection is the primary accent; keyboard focus is a solid ring
				// outside the border, so the two never read as the same state.
				selected && "border-primary/60 bg-primary/5 hover:border-primary/70",
				"has-[[data-board-card]:focus-visible]:ring-2 has-[[data-board-card]:focus-visible]:ring-ring"
			)}
			data-thread-id={thread.id}
		>
			<div className="flex min-w-0 flex-col gap-1">
				<div className="flex min-w-0 items-start gap-2">
					{showStatus ? (
						// Linear's convention: the status mark leads the title row,
						// so every card keeps the same three-line silhouette.
						<span className="flex h-5 shrink-0 items-center">
							<BoardStatusDot pulse={false} status={status} />
						</span>
					) : null}
					<h3 className="min-w-0 font-medium text-foreground text-sm leading-5">
						{showStatus ? (
							<span className="sr-only">{THREAD_STATUS_LABELS[status]}: </span>
						) : null}
						<button
							aria-current={selected ? "true" : undefined}
							aria-describedby={excerptId}
							className="line-clamp-2 text-left outline-none after:absolute after:inset-0 after:rounded-lg after:content-['']"
							data-board-card=""
							data-column={columnIndex}
							data-row={rowIndex}
							onClick={() => onOpen(thread.id)}
							tabIndex={tabStop ? 0 : -1}
							type="button"
						>
							{title}
						</button>
					</h3>
				</div>
				<p
					className="line-clamp-2 text-[13px] text-foreground/70 leading-[18px]"
					id={excerptId}
				>
					{thread.lastMessage ? (
						<>
							{thread.lastMessageRole === "user" ? "You: " : null}
							{thread.lastMessage}
						</>
					) : (
						"No messages yet"
					)}
				</p>
			</div>
			<div className="flex h-5 min-w-0 items-center gap-2 text-muted-foreground text-xs">
				<CardFaces agents={agents} />
				{failed ? (
					<span className="shrink-0 font-medium text-destructive">
						{failureLabel(thread)}
					</span>
				) : null}
				{group ? <BoardGroupName group={group} /> : null}
				<span className="ml-auto flex shrink-0 items-center gap-3 tabular-nums">
					{thread.pinned ? (
						<span className="inline-flex items-center">
							<Pin aria-hidden="true" className={cn(META_ICON, "rotate-45")} />
							<span className="sr-only">Pinned</span>
						</span>
					) : null}
					<span className="inline-flex items-center gap-1">
						<MessageSquare aria-hidden="true" className={META_ICON} />
						{thread.messageCount}
						<span className="sr-only">
							{thread.messageCount === 1 ? " message" : " messages"}
						</span>
					</span>
					{age ? (
						<time
							className="min-w-6 text-right"
							dateTime={thread.updatedAt}
							title={new Date(thread.updatedAt).toLocaleString()}
						>
							<span className="sr-only">Updated </span>
							{age}
						</time>
					) : null}
				</span>
			</div>
		</article>
	);
}

/**
 * A team or project named in plain text behind a small glyph, the same on
 * cards, list rows, and anywhere else the board names where a thread lives.
 */
export function BoardGroupName({
	className,
	group,
}: {
	className?: string;
	group: InterfaceGroup;
}) {
	const Icon = group.kind === "team" ? Users : Folder;
	return (
		<span
			className={cn(
				"inline-flex min-w-0 items-center gap-1 text-muted-foreground",
				className
			)}
		>
			<Icon aria-hidden="true" className={META_ICON} />
			<span className="sr-only">
				{group.kind === "team" ? "Team" : "Project"}:{" "}
			</span>
			<span className="truncate">{group.name}</span>
		</span>
	);
}

/**
 * Status as a coloured mark beside quiet text: only the mark carries colour
 * (failures excepted), the way Linear colours the status icon, not the label.
 */
export function BoardStatusText({ status }: { status: ThreadStatus }) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1.5 text-xs",
				status === "attention" ? "text-destructive" : "text-muted-foreground"
			)}
		>
			<BoardStatusDot pulse={false} status={status} />
			{THREAD_STATUS_LABELS[status]}
		</span>
	);
}
