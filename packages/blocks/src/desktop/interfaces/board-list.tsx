import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type BoardColumn,
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ChevronRight, MessageSquare, Pin, Plus } from "lucide-react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardGroupName } from "./board-card.tsx";
import {
	BoardGroupMark,
	type BoardStartInput,
	columnStartInput,
} from "./board-column.tsx";
import { BoardStatusDot } from "./board-status.tsx";
import { agentById, compactAge } from "./interface-renderer.ts";

/** Attribute the list's arrow-key navigation looks for. */
export const BOARD_ROW_ATTRIBUTE = "data-board-row";

const STACK_LIMIT = 3;

function participants(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): InterfaceAgent[] {
	return thread.agentIds.flatMap((id) => {
		const agent = agentById(snapshot, id);
		return agent ? [agent] : [];
	});
}

/**
 * The team or project worth naming on a row: never the one the list is
 * already grouped by, so a row in the "Site" section does not repeat "Site".
 */
function rowGroup(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread,
	groupedByProject: boolean
): InterfaceGroup | undefined {
	const ids = groupedByProject
		? [thread.teamId]
		: [thread.projectId, thread.teamId];
	for (const id of ids) {
		const group = id
			? snapshot.groups.find((candidate) => candidate.id === id)
			: undefined;
		if (group) {
			return group;
		}
	}
	return;
}

function RowFaces({ agents }: { agents: InterfaceAgent[] }) {
	if (agents.length === 0) {
		return (
			<span
				aria-hidden="true"
				className="size-5 shrink-0 rounded-full border border-muted-foreground/50 border-dashed"
			/>
		);
	}
	const shown = agents.slice(0, STACK_LIMIT);
	return (
		<span aria-hidden="true" className="flex shrink-0 -space-x-1.5">
			{shown.map((agent) => (
				<BoardAvatar
					agent={agent}
					className="ring-2 ring-background"
					key={agent.id}
					name={agent.name}
					size={20}
				/>
			))}
		</span>
	);
}

/**
 * One thread as a dense list row: status, title, the newest line, then where
 * it lives, who is on it, and how fresh it is. The title is the row's single
 * control; its hit area covers the row.
 */
function BoardListRow({
	compact,
	groupedByProject,
	index,
	now,
	onOpen,
	selected,
	snapshot,
	tabStop,
	thread,
}: {
	compact: boolean;
	groupedByProject: boolean;
	index: number;
	now: number;
	onOpen: (threadId: string) => void;
	selected: boolean;
	snapshot: InterfaceSnapshot;
	tabStop: boolean;
	thread: InterfaceThread;
}) {
	const tl = useLiteralMessages();
	const status = threadStatus(thread);
	const agents = participants(snapshot, thread);
	const group = rowGroup(snapshot, thread, groupedByProject);
	const title = thread.title.trim() || "Untitled thread";
	const age = compactAge(thread.updatedAt, now);
	const detailsId = `board-row-details-${thread.id}`;
	const names = agents.map((agent) => agent.name).join(", ");
	return (
		<li
			className={cn(
				"relative flex h-11 scroll-mt-9 items-center gap-3 border-border/50 border-b pr-4 pl-5 text-sm",
				"hover:bg-muted/50 has-[[data-board-row]:focus-visible]:bg-muted/60 has-[[data-board-row]:focus-visible]:ring-2 has-[[data-board-row]:focus-visible]:ring-ring has-[[data-board-row]:focus-visible]:ring-inset",
				selected && "bg-accent/60 hover:bg-accent/60"
			)}
			data-thread-id={thread.id}
		>
			<BoardStatusDot pulse={false} status={status} />
			<button
				aria-current={selected ? "true" : undefined}
				aria-describedby={detailsId}
				className="min-w-0 shrink truncate text-left font-medium text-foreground outline-none after:absolute after:inset-0 after:content-['']"
				data-board-row=""
				data-index={index}
				onClick={() => onOpen(thread.id)}
				tabIndex={tabStop ? 0 : -1}
				type="button"
			>
				{title}
			</button>
			<span
				className={cn(
					"min-w-0 flex-1 basis-0 truncate text-[13px] text-foreground/70",
					compact && "sr-only"
				)}
				id={detailsId}
			>
				<span className="sr-only">
					{THREAD_STATUS_LABELS[status]}
					{names ? tl(", with {names}", { names }) : ""}
					{thread.lastMessage ? ". " : ""}
				</span>
				{thread.lastMessage ? (
					<>
						{thread.lastMessageRole === "user" ? "You: " : ""}
						{thread.lastMessage}
					</>
				) : null}
			</span>
			{compact ? <span className="flex-1" /> : null}
			<span className="flex shrink-0 items-center gap-3 text-muted-foreground text-xs">
				{status === "attention" ? (
					<span className="@min-[520px]:inline hidden shrink-0 font-medium text-destructive">
						{thread.runState === "interrupted"
							? "Run interrupted"
							: "Last run failed"}
					</span>
				) : null}
				{group && !compact ? (
					<BoardGroupName
						className="@min-[640px]:inline-flex hidden max-w-40"
						group={group}
					/>
				) : null}
				{/* A fixed slot, so groups, faces, and ages line up across rows. */}
				<span className="inline-flex w-3.5 shrink-0 items-center">
					{thread.pinned ? (
						<>
							<Pin aria-hidden="true" className="size-3.5 rotate-45" />
							<span className="sr-only">Pinned</span>
						</>
					) : null}
				</span>
				{/* A fixed, right-aligned slot as wide as three faces, so a
				    longer stack never pushes the groups out of line. */}
				<span className="flex w-12 shrink-0 justify-end">
					<RowFaces agents={agents} />
				</span>
				<span className="@min-[520px]:inline-flex hidden w-9 shrink-0 items-center justify-end gap-1 tabular-nums">
					<MessageSquare aria-hidden="true" className="size-3.5 shrink-0" />
					{thread.messageCount}
					<span className="sr-only">
						{thread.messageCount === 1 ? " message" : " messages"}
					</span>
				</span>
				<span className="w-8 text-right tabular-nums">
					{age ? (
						<time
							dateTime={thread.updatedAt}
							title={new Date(thread.updatedAt).toLocaleString()}
						>
							<span className="sr-only">Updated </span>
							{age}
						</time>
					) : null}
				</span>
			</span>
		</li>
	);
}

/**
 * One section: a sticky header (collapse toggle, group mark, name, count, and
 * a "+" for agent and project groups) over its rows.
 */
function BoardListSection({
	collapsed,
	column,
	compact,
	firstIndex,
	groupedByProject,
	now,
	onOpen,
	onStart,
	onToggle,
	selectedThreadId,
	snapshot,
	tabStopThreadId,
	threadsById,
}: {
	collapsed: boolean;
	column: BoardColumn;
	compact: boolean;
	/** List-wide index of this section's first row (for arrow navigation). */
	firstIndex: number;
	groupedByProject: boolean;
	now: number;
	onOpen: (threadId: string) => void;
	onStart: (input: BoardStartInput) => void;
	onToggle: (columnId: string) => void;
	selectedThreadId: string | null;
	snapshot: InterfaceSnapshot;
	tabStopThreadId: string | null;
	threadsById: ReadonlyMap<string, InterfaceThread>;
}) {
	const tl = useLiteralMessages();
	const agent = agentById(snapshot, column.agentId);
	const start = columnStartInput(column);
	const startLabel = column.groupId
		? tl("New thread in {label}", { label: column.label })
		: tl("New thread with {label}", { label: column.label });
	const threads = column.threadIds.flatMap((id) => {
		const thread = threadsById.get(id);
		return thread ? [thread] : [];
	});
	const rowsId = `board-section-${column.id}`;
	return (
		<section aria-label={column.label}>
			<header className="group/section sticky top-0 z-10 flex h-9 items-center gap-1 border-border/60 border-b bg-background bg-linear-to-b from-muted/50 to-muted/50 pr-3 pl-1.5">
				<button
					aria-controls={rowsId}
					aria-expanded={!collapsed}
					className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-left outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring"
					onClick={() => onToggle(column.id)}
					type="button"
				>
					<ChevronRight
						aria-hidden="true"
						className={cn(
							"size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
							!collapsed && "rotate-90"
						)}
					/>
					<BoardGroupMark agent={agent} column={column} size="sm" />
					<h2 className="truncate font-semibold text-foreground text-sm">
						{column.label}
					</h2>
					<span className="text-muted-foreground text-sm tabular-nums">
						{threads.length}
						<span className="sr-only">
							{threads.length === 1 ? " thread" : " threads"}
						</span>
					</span>
				</button>
				<span className="flex-1" />
				{start ? (
					<Button
						aria-label={startLabel}
						className="text-muted-foreground opacity-0 pointer-coarse:opacity-100 transition-opacity duration-100 focus-visible:opacity-100 group-hover/section:opacity-100 motion-reduce:transition-none"
						onClick={() => onStart(start)}
						size="icon-xs"
						title={startLabel}
						type="button"
						variant="ghost"
					>
						<Plus aria-hidden="true" />
					</Button>
				) : null}
			</header>
			{collapsed ? null : (
				<ul id={rowsId}>
					{threads.map((thread, rowIndex) => (
						<BoardListRow
							compact={compact}
							groupedByProject={groupedByProject}
							index={firstIndex + rowIndex}
							key={thread.id}
							now={now}
							onOpen={onOpen}
							selected={thread.id === selectedThreadId}
							snapshot={snapshot}
							tabStop={thread.id === tabStopThreadId}
							thread={thread}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

/**
 * The Board's list view: every group as a collapsible section of dense rows.
 * Empty groups are left out (the command menu and "+" still start threads in
 * them); the caller shows its own empty state when nothing matches.
 */
export function BoardListView({
	collapsedIds,
	columns,
	compact,
	groupedByProject,
	now,
	onOpen,
	onStart,
	onToggle,
	selectedThreadId,
	snapshot,
	tabStopThreadId,
	threadsById,
}: {
	collapsedIds: ReadonlySet<string>;
	columns: BoardColumn[];
	compact: boolean;
	groupedByProject: boolean;
	now: number;
	onOpen: (threadId: string) => void;
	onStart: (input: BoardStartInput) => void;
	onToggle: (columnId: string) => void;
	selectedThreadId: string | null;
	snapshot: InterfaceSnapshot;
	tabStopThreadId: string | null;
	threadsById: ReadonlyMap<string, InterfaceThread>;
}) {
	let nextIndex = 0;
	return (
		<>
			{columns
				.filter((column) => column.threadIds.length > 0)
				.map((column) => {
					const collapsed = collapsedIds.has(column.id);
					const firstIndex = nextIndex;
					if (!collapsed) {
						nextIndex += column.threadIds.length;
					}
					return (
						<BoardListSection
							collapsed={collapsed}
							column={column}
							compact={compact}
							firstIndex={firstIndex}
							groupedByProject={groupedByProject}
							key={column.id}
							now={now}
							onOpen={onOpen}
							onStart={onStart}
							onToggle={onToggle}
							selectedThreadId={selectedThreadId}
							snapshot={snapshot}
							tabStopThreadId={tabStopThreadId}
							threadsById={threadsById}
						/>
					);
				})}
		</>
	);
}

const SKELETON_SECTIONS = [
	["section-1", 3],
	["section-2", 4],
	["section-3", 2],
] as const;

/** Placeholder sections that hold the list's shape until the first load. */
export function BoardListSkeleton() {
	return (
		<div aria-hidden="true">
			{SKELETON_SECTIONS.map(([id, rows]) => (
				<div key={id}>
					<div className="flex h-9 items-center gap-2 border-border/60 border-b bg-muted/50 px-4">
						<Skeleton className="size-2 rounded-full" />
						<Skeleton className="h-3.5 w-24" />
					</div>
					{Array.from({ length: rows }, (_, row) => `${id}-row-${row}`).map(
						(rowId) => (
							<div
								className="flex h-11 items-center gap-3 border-border/50 border-b pr-4 pl-5"
								key={rowId}
							>
								<Skeleton className="size-2 rounded-full" />
								<Skeleton className="h-3.5 w-48" />
								<Skeleton className="h-3 flex-1" />
								<Skeleton className="size-5 rounded-full" />
								<Skeleton className="h-3 w-8" />
							</div>
						)
					)}
				</div>
			))}
		</div>
	);
}
