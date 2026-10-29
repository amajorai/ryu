import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Pin } from "lucide-react";
import type { ReactNode } from "react";
import { type ForumTopic, fullDate, plural } from "./forum-model.ts";
import {
	CategoryBadge,
	PosterList,
	TEXT_BUTTON,
	TopicStatusNote,
	UnreadDot,
} from "./forum-parts.tsx";
import { compactAge } from "./interface-renderer.ts";

/** Column visibility by container width (Discourse drops columns as it narrows). */
const COL_POSTERS = "hidden @min-[720px]:table-cell";
const COL_REPLIES = "hidden @min-[720px]:table-cell";
const COL_VIEWS = "hidden @min-[900px]:table-cell";

const HEAD_CELL =
	"h-10 px-2 text-center align-middle font-normal text-muted-foreground text-sm";
const NUM_CELL =
	"px-2 text-center align-middle text-muted-foreground text-sm tabular-nums";

export interface TopicTableProps {
	/** Shown under the last row, or alone when there are no rows. */
	footer: ReactNode;
	now: number;
	onOpen: (threadId: string) => void;
	onSelectCategory: ((categoryId: string) => void) | null;
	rowRef: (threadId: string, element: HTMLTableRowElement | null) => void;
	selectedId: string | null;
	topics: readonly ForumTopic[];
}

function TopicRow({
	now,
	onOpen,
	onSelectCategory,
	rowRef,
	selected,
	tabStop,
	topic,
}: {
	now: number;
	onOpen: (threadId: string) => void;
	onSelectCategory: ((categoryId: string) => void) | null;
	rowRef: (threadId: string, element: HTMLTableRowElement | null) => void;
	/** Picked with j/k or the arrow keys: Discourse's left-edge marker. */
	selected: boolean;
	/** The list's single tab stop (roving focus). */
	tabStop: boolean;
	topic: ForumTopic;
}) {
	const { thread } = topic;
	const unread = topic.status === "your-turn";
	return (
		<tr
			className={cn(
				"group/topic relative border-border border-b transition-colors duration-100 hover:bg-muted/40",
				selected && "bg-muted/40 shadow-[inset_3px_0_0_var(--primary)]"
			)}
			data-selected={selected || undefined}
			data-thread-id={thread.id}
			ref={(element) => rowRef(thread.id, element)}
		>
			<td className="py-3 pr-2 pl-3 align-middle">
				<div className="flex min-w-0 items-center gap-2">
					{thread.pinned ? (
						<Pin
							aria-label="Pinned"
							className="size-3.5 shrink-0 text-muted-foreground"
							role="img"
							strokeWidth={2}
						/>
					) : null}
					<button
						className={cn(
							"min-w-0 truncate rounded-sm text-left text-[15px] leading-5 outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/50 in-data-selected:focus-visible:after:ring-0 focus-visible:after:ring-inset",
							unread
								? "font-semibold text-foreground"
								: "font-medium text-foreground"
						)}
						data-topic-title={thread.id}
						onClick={() => onOpen(thread.id)}
						tabIndex={tabStop ? 0 : -1}
						type="button"
					>
						{thread.title || "Untitled topic"}
					</button>
					{unread ? <UnreadDot className="shrink-0" /> : null}
				</div>
				<div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
					<CategoryBadge
						category={topic.category}
						onSelect={onSelectCategory ?? undefined}
					/>
					<TopicStatusNote topic={topic} />
					<span className="@min-[720px]:hidden text-muted-foreground text-xs tabular-nums leading-4">
						{plural(topic.replies, "reply", "replies")}
					</span>
				</div>
				{thread.pinned && thread.lastMessage ? (
					<p className="mt-1.5 line-clamp-2 max-w-[60ch] text-muted-foreground text-sm leading-5">
						{thread.lastMessage}
					</p>
				) : null}
			</td>
			<td className={cn(COL_POSTERS, "px-2 align-middle")}>
				<PosterList topic={topic} />
			</td>
			<td className={cn(COL_REPLIES, NUM_CELL)}>{topic.replies}</td>
			<td className={cn(COL_VIEWS, NUM_CELL)}>{topic.views}</td>
			<td className={cn(NUM_CELL, "pr-3")}>
				<time dateTime={thread.updatedAt} title={fullDate(thread.updatedAt)}>
					{compactAge(thread.updatedAt, now)}
				</time>
			</td>
		</tr>
	);
}

/**
 * Discourse's topic list: Topic, posters, Replies, Views, Activity. The title
 * stretches over its row so the whole row opens the topic; the category badge
 * sits above that layer and filters instead.
 */
export function TopicTable({
	footer,
	now,
	onOpen,
	onSelectCategory,
	rowRef,
	selectedId,
	topics,
}: TopicTableProps) {
	// Roving focus: the selected row's title is the list's tab stop.
	const tabStop = selectedId ?? topics[0]?.thread.id ?? null;
	return (
		<div data-testid="forum-topic-list">
			<table className="w-full table-fixed border-collapse">
				<colgroup>
					<col />
					<col className="@min-[720px]:table-column hidden w-36" />
					<col className="@min-[720px]:table-column hidden w-20" />
					<col className="@min-[900px]:table-column hidden w-20" />
					<col className="w-20" />
				</colgroup>
				<thead>
					<tr className="border-border border-b">
						<th className={cn(HEAD_CELL, "pl-3 text-left")} scope="col">
							Topic
						</th>
						<th className={cn(HEAD_CELL, COL_POSTERS)} scope="col">
							<span className="sr-only">Posters</span>
						</th>
						<th className={cn(HEAD_CELL, COL_REPLIES)} scope="col">
							Replies
						</th>
						<th className={cn(HEAD_CELL, COL_VIEWS)} scope="col">
							Views
						</th>
						<th className={cn(HEAD_CELL, "pr-3")} scope="col">
							Activity
						</th>
					</tr>
				</thead>
				<tbody>
					{topics.map((topic) => (
						<TopicRow
							key={topic.thread.id}
							now={now}
							onOpen={onOpen}
							onSelectCategory={onSelectCategory}
							rowRef={rowRef}
							selected={topic.thread.id === selectedId}
							tabStop={topic.thread.id === tabStop}
							topic={topic}
						/>
					))}
				</tbody>
			</table>
			{footer}
		</div>
	);
}

/** The line under a list, with the follow-on links Discourse offers. */
export function ListFooter({
	actions,
	message,
}: {
	actions: { label: string; onClick: () => void }[];
	message: string;
}) {
	return (
		<p className="px-3 py-6 text-muted-foreground text-sm">
			{message}
			{actions.map((action, index) => (
				<span key={action.label}>
					{index === 0 ? " " : " or "}
					<button
						className={cn(TEXT_BUTTON, "text-primary")}
						onClick={action.onClick}
						type="button"
					>
						{index === 0
							? action.label
							: action.label.charAt(0).toLowerCase() + action.label.slice(1)}
					</button>
				</span>
			))}
			{actions.length > 0 ? "." : null}
		</p>
	);
}

const SKELETON_ROWS = [
	{ id: "a", title: "w-[52%]" },
	{ id: "b", title: "w-[38%]" },
	{ id: "c", title: "w-[61%]" },
	{ id: "d", title: "w-[44%]" },
	{ id: "e", title: "w-[56%]" },
	{ id: "f", title: "w-[33%]" },
	{ id: "g", title: "w-[48%]" },
];

/** Placeholder rows that hold the table's shape while the snapshot loads. */
export function TopicTableSkeleton() {
	return (
		<div aria-busy="true" aria-label="Loading topics" role="status">
			<div className="flex h-10 items-center border-border border-b px-3">
				<Skeleton className="h-3 w-12" radius="dense" />
			</div>
			{SKELETON_ROWS.map((row) => (
				<div
					className="flex h-[65px] items-center gap-4 border-border border-b px-3"
					key={row.id}
				>
					<div className="flex min-w-0 flex-1 flex-col gap-2">
						<Skeleton className={cn("h-3.5", row.title)} radius="dense" />
						<Skeleton className="h-2.5 w-24" radius="dense" />
					</div>
					<div className="@min-[720px]:flex hidden gap-1">
						<Skeleton className="size-6" radius="pill" />
						<Skeleton className="size-6" radius="pill" />
					</div>
					<Skeleton
						className="@min-[720px]:block hidden h-3 w-6"
						radius="dense"
					/>
					<Skeleton className="h-3 w-6" radius="dense" />
				</div>
			))}
		</div>
	);
}
