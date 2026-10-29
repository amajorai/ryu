import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	BoardColumn,
	InterfaceAgent,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { FolderKanban, Plus } from "lucide-react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardCard } from "./board-card.tsx";
import { BOARD_STATUS_EMPTY, BoardStatusDot } from "./board-status.tsx";
import { agentById } from "./interface-renderer.ts";

/** Attribute on every lane; the board snaps and scrolls lane by lane. */
export const BOARD_LANE_ATTRIBUTE = "data-board-lane";
/** Attribute on a lane's own vertical scroller. */
export const BOARD_LANE_SCROLL_ATTRIBUTE = "data-board-lane-scroll";

const LANE =
	"group/lane flex h-full shrink-0 snap-start flex-col rounded-lg bg-muted/40 transition-[width] duration-200 ease-out motion-reduce:transition-none";
/**
 * Lanes are 300px when they overflow the board (so columns line up like a
 * real Kanban board) and grow evenly to 360px when every lane fits, so the
 * board never ends in a dead gutter.
 */
const LANE_WIDTH = "w-75 max-w-90 grow";
/**
 * While a thread is open the lanes split the board's width evenly (one to
 * four, by the space left beside the panel), so the board always rests on
 * whole lanes and never leaves a sliver of a neighbour at either edge.
 * `100cqw` is the board's content box; 12px is the gap between lanes.
 */
const LANE_WIDTH_COMPACT = [
	"w-[100cqw]",
	"@min-[500px]:w-[calc((100cqw_-_12px)/2)]",
	"@min-[780px]:w-[calc((100cqw_-_24px)/3)]",
	"@min-[1060px]:w-[calc((100cqw_-_36px)/4)]",
].join(" ");

function participants(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): InterfaceAgent[] {
	return thread.agentIds.flatMap((id) => {
		const agent = agentById(snapshot, id);
		return agent ? [agent] : [];
	});
}

/** What starting a thread from a group files it under; null when nothing. */
export interface BoardStartInput {
	agentId?: string;
	projectId?: string;
}

/** Agent and project groups can start a thread in place; status groups cannot. */
export function columnStartInput(column: BoardColumn): BoardStartInput | null {
	if (column.agentId) {
		return { agentId: column.agentId };
	}
	if (column.groupId) {
		return { projectId: column.groupId };
	}
	return null;
}

/** The mark before a group's name: status dot, agent face, or project tile. */
export function BoardGroupMark({
	agent,
	column,
	size = "md",
}: {
	agent: InterfaceAgent | undefined;
	column: BoardColumn;
	size?: "md" | "sm";
}) {
	if (column.status) {
		return (
			<BoardStatusDot
				className={size === "sm" ? "size-2" : "size-2.5"}
				pulse={false}
				status={column.status}
			/>
		);
	}
	if (column.groupId) {
		return (
			<span
				aria-hidden="true"
				className={cn(
					"flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
					size === "sm" ? "size-5" : "size-6"
				)}
			>
				<FolderKanban className={size === "sm" ? "size-3" : "size-3.5"} />
			</span>
		);
	}
	if (!agent) {
		return (
			<span
				aria-hidden="true"
				className={cn(
					"shrink-0 rounded-full border border-muted-foreground/50 border-dashed",
					size === "sm" ? "size-5" : "size-6"
				)}
			/>
		);
	}
	return (
		<span className="relative shrink-0">
			<BoardAvatar
				agent={agent}
				name={agent.name}
				size={size === "sm" ? 20 : 24}
			/>
			{agent.status === "working" ? (
				<span
					aria-hidden="true"
					className="absolute -right-0.5 -bottom-0.5 flex size-3 items-center justify-center rounded-full bg-muted"
				>
					<BoardStatusDot className="size-2" pulse={false} status="working" />
				</span>
			) : null}
		</span>
	);
}

/** What an empty group says, in the user's terms. */
export function boardGroupEmptyText(
	column: BoardColumn,
	tl: LiteralMessage
): string {
	if (column.status) {
		return BOARD_STATUS_EMPTY[column.status];
	}
	if (column.groupId) {
		return tl("No threads in {label}", { label: column.label });
	}
	return tl("No threads with {label}", { label: column.label });
}

function ColumnEmpty({
	column,
	onStart,
}: {
	column: BoardColumn;
	onStart: (input: BoardStartInput) => void;
}) {
	const tl = useLiteralMessages();
	const start = columnStartInput(column);
	return (
		<div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
			<p className="text-[13px] text-muted-foreground">
				{boardGroupEmptyText(column, tl)}
			</p>
			{start ? (
				<Button
					onClick={() => onStart(start)}
					size="xs"
					type="button"
					variant="ghost"
				>
					<Plus aria-hidden="true" data-icon="inline-start" />
					Start a thread
				</Button>
			) : null}
		</div>
	);
}

/** One lane: header (status mark or agent face, count, "+") and its cards. */
export function BoardColumnView({
	activeThreadId,
	column,
	columnIndex,
	compact,
	now,
	onOpen,
	onStart,
	snapshot,
	tabStopThreadId,
	threadsById,
}: {
	activeThreadId: string | null;
	column: BoardColumn;
	columnIndex: number;
	/** Use the narrower lane width (a thread is open beside the board). */
	compact: boolean;
	now: number;
	onOpen: (threadId: string) => void;
	onStart: (input: BoardStartInput) => void;
	snapshot: InterfaceSnapshot;
	/** The one card that is in the Tab order (roving tabindex). */
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
	const headingId = `board-column-${column.id}`;
	const descriptionId = `board-column-${column.id}-description`;
	return (
		<section
			aria-describedby={agent ? descriptionId : undefined}
			aria-labelledby={headingId}
			className={cn(LANE, compact ? LANE_WIDTH_COMPACT : LANE_WIDTH)}
			data-board-lane=""
		>
			<header className="flex h-11 shrink-0 items-center gap-2 pr-2 pl-5">
				<BoardGroupMark agent={agent} column={column} />
				<h2
					className="min-w-0 truncate font-semibold text-foreground text-sm"
					id={headingId}
					title={agent?.description || undefined}
				>
					{column.label}
					<span className="sr-only">
						, {threads.length} {threads.length === 1 ? "thread" : "threads"}
					</span>
				</h2>
				<span
					aria-hidden="true"
					className="shrink-0 text-muted-foreground text-sm tabular-nums"
				>
					{threads.length}
				</span>
				{agent ? (
					<span className="sr-only" id={descriptionId}>
						{agent.status === "working"
							? "Working"
							: agent.description || "Idle"}
					</span>
				) : null}
				<span className="flex-1" />
				{start ? (
					<Button
						aria-label={startLabel}
						className="text-muted-foreground opacity-0 pointer-coarse:opacity-100 transition-opacity duration-100 focus-visible:opacity-100 group-hover/lane:opacity-100 group-has-[:focus-visible]/lane:opacity-100 motion-reduce:transition-none"
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
			{/* Not a Tab stop: arrow keys move between cards and scroll the lane. */}
			<div
				className="scroll-fade no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none"
				data-board-lane-scroll=""
				tabIndex={-1}
			>
				{threads.length > 0 ? (
					<ul className="flex flex-col gap-2 px-2 pb-2">
						{threads.map((thread, rowIndex) => (
							<li key={thread.id}>
								<BoardCard
									agents={participants(snapshot, thread)}
									columnIndex={columnIndex}
									group={snapshot.groups.find(
										(group) =>
											// A project lane already names the project.
											(group.id === thread.projectId && !column.groupId) ||
											group.id === thread.teamId
									)}
									now={now}
									onOpen={onOpen}
									rowIndex={rowIndex}
									selected={thread.id === activeThreadId}
									showStatus={column.status === null}
									tabStop={thread.id === tabStopThreadId}
									thread={thread}
								/>
							</li>
						))}
					</ul>
				) : (
					<div className="px-2 pb-2">
						<ColumnEmpty column={column} onStart={onStart} />
					</div>
				)}
			</div>
		</section>
	);
}

const SKELETON_LANES = ["lane-1", "lane-2", "lane-3", "lane-4"] as const;
const SKELETON_CARDS = ["card-1", "card-2", "card-3"] as const;

/** Placeholder lanes that hold the board's shape until the first load. */
export function BoardColumnsSkeleton({ compact }: { compact: boolean }) {
	return (
		<>
			{SKELETON_LANES.map((lane, laneIndex) => (
				<div
					aria-hidden="true"
					className={cn(LANE, compact ? LANE_WIDTH_COMPACT : LANE_WIDTH)}
					key={lane}
				>
					<div className="flex h-11 items-center gap-2 pr-2 pl-5">
						<Skeleton className="size-2.5 rounded-full" />
						<Skeleton className="h-3.5 w-24" />
					</div>
					<div className="flex flex-col gap-2 px-2">
						{SKELETON_CARDS.slice(0, 3 - (laneIndex % 2)).map((card) => (
							<div
								className="flex flex-col gap-3 rounded-lg border border-border bg-card px-3.5 py-3"
								key={card}
							>
								<div className="flex flex-col gap-1">
									<div className="flex h-5 items-center">
										<Skeleton className="h-3.5 w-4/5" />
									</div>
									<div className="flex h-[18px] items-center">
										<Skeleton className="h-3 w-full" />
									</div>
									<div className="flex h-[18px] items-center">
										<Skeleton className="h-3 w-3/5" />
									</div>
								</div>
								<div className="flex h-5 items-center justify-between">
									<Skeleton className="size-5 rounded-full" />
									<Skeleton className="h-3 w-12" />
								</div>
							</div>
						))}
					</div>
				</div>
			))}
		</>
	);
}
