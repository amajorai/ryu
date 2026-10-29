import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd, KbdGroup } from "@ryu/ui/components/kbd.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type DeskView,
	THREAD_STATUS_LABELS,
} from "@ryuhq/protocol/interfaces";
import { ArrowDownUp, Pin, SquarePen } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { DeskAvatar } from "./desk-avatar.tsx";
import {
	type DeskRow,
	type DeskSort,
	deskEmptyCopy,
	deskStartLabel,
	pluralize,
} from "./desk-model.ts";
import { DeskRowMark } from "./desk-status.tsx";
import { compactAge } from "./interface-renderer.ts";

/** The one keyboard-focus treatment shared by rail items, rows and links. */
export const DESK_FOCUS_RING =
	"outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset";

const ROW_CURSOR =
	"bg-foreground/5 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary";
const ROW_CURSOR_FOCUS =
	"focus-visible:bg-foreground/5 focus-visible:before:absolute focus-visible:before:inset-y-0 focus-visible:before:left-0 focus-visible:before:w-0.5 focus-visible:before:bg-primary";

/** Legend chips: a hairline outline so glyphs keep full contrast in dark themes. */
const LEGEND_KBD =
	"bg-transparent text-foreground ring-1 ring-border ring-inset";

const SORT_LABELS: Record<DeskSort, string> = {
	newest: "Newest",
	oldest: "Oldest",
};

function spokenAge(age: string): string {
	if (!age) {
		return "";
	}
	return age === "now" ? "updated just now" : `updated ${age} ago`;
}

/** Keys that move the roving cursor, mapped to a step through the list. */
export function deskCursorStep(
	key: string
): "first" | "last" | "next" | "previous" | null {
	switch (key) {
		case "ArrowDown":
		case "j":
			return "next";
		case "ArrowUp":
		case "k":
			return "previous";
		case "Home":
			return "first";
		case "End":
			return "last";
		default:
			return null;
	}
}

function DeskListRow({
	cursor,
	marked,
	now,
	onFocusRow,
	onKeyDownRow,
	onOpen,
	registerRow,
	row,
	selected,
}: {
	cursor: boolean;
	/** Keyboard position away from the open row: a bar on the left edge. */
	marked: boolean;
	now: number;
	onFocusRow: (threadId: string) => void;
	onKeyDownRow: (event: KeyboardEvent<HTMLElement>, threadId: string) => void;
	onOpen: (threadId: string) => void;
	registerRow: (threadId: string, element: HTMLElement | null) => void;
	row: DeskRow;
	selected: boolean;
}) {
	const { thread } = row;
	const age = compactAge(thread.updatedAt, now);
	const previewId = `desk-preview-${thread.id}`;
	const label = [
		row.title,
		row.actorLabel,
		THREAD_STATUS_LABELS[row.status],
		row.needsYou ? "needs you" : "",
		thread.pinned ? "pinned" : "",
		spokenAge(age),
	]
		.filter(Boolean)
		.join(", ");
	// On the accent surface of a selected row, muted text drops to ~2:1 in
	// dark themes, so every tone is taken from accent-foreground instead.
	const strong = selected ? "text-accent-foreground" : "text-foreground";
	const secondary = selected
		? "text-accent-foreground/70"
		: "text-muted-foreground";
	return (
		<div
			aria-describedby={previewId}
			aria-label={label}
			aria-selected={selected}
			className={cn(
				"relative flex cursor-default scroll-my-0 gap-3 px-4 py-3 outline-none transition-colors",
				// One cursor treatment, Linear/Front style: a muted row with a bar
				// on its left edge. The open row already reads as selected.
				selected
					? "bg-accent text-accent-foreground"
					: cn(ROW_CURSOR_FOCUS, "hover:bg-foreground/[0.03]"),
				marked && ROW_CURSOR
			)}
			data-cursor={marked ? "" : undefined}
			data-needs-you={row.needsYou ? "" : undefined}
			data-status={row.status}
			data-testid={`desk-row-${thread.id}`}
			id={`desk-row-${thread.id}`}
			onClick={() => onOpen(thread.id)}
			onFocus={() => onFocusRow(thread.id)}
			onKeyDown={(event) => onKeyDownRow(event, thread.id)}
			ref={(element) => registerRow(thread.id, element)}
			role="option"
			tabIndex={cursor ? 0 : -1}
		>
			<DeskAvatar
				agent={row.lead}
				className="self-start"
				presence
				size={32}
				surface={selected ? "accent" : "background"}
			/>
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="flex h-5 min-w-0 items-center gap-2">
					<span
						className={cn(
							"min-w-0 flex-1 truncate font-medium text-[13px] leading-5",
							strong
						)}
					>
						{row.actorLabel}
					</span>
					{thread.pinned ? (
						<Pin
							aria-hidden="true"
							className={cn("size-3 shrink-0", secondary)}
						/>
					) : null}
					<DeskRowMark onAccent={selected} status={row.status} />
					<time
						className={cn(
							"shrink-0 text-xs tabular-nums",
							row.needsYou ? cn("font-medium", strong) : secondary
						)}
						dateTime={thread.updatedAt}
					>
						{age}
					</time>
				</div>
				<p
					className={cn(
						"truncate text-sm leading-5",
						row.needsYou ? "font-semibold" : "font-normal",
						strong
					)}
				>
					{row.title}
				</p>
				<p
					className={cn("truncate text-[13px] leading-5", secondary)}
					id={previewId}
				>
					{row.preview}
				</p>
			</div>
		</div>
	);
}

const SKELETON_ROWS = [
	{ id: "a", line: "w-2/3", name: "w-16" },
	{ id: "b", line: "w-1/2", name: "w-20" },
	{ id: "c", line: "w-3/4", name: "w-12" },
	{ id: "d", line: "w-3/5", name: "w-16" },
	{ id: "e", line: "w-1/2", name: "w-24" },
	{ id: "f", line: "w-2/3", name: "w-14" },
] as const;

/** Placeholder rows in the real rows' shape: 84px, avatar and three lines. */
function DeskSkeletonRows() {
	return (
		<div
			aria-busy="true"
			aria-label="Loading conversations"
			className="flex flex-col"
			data-testid="desk-skeleton"
			role="status"
		>
			{SKELETON_ROWS.map((row) => (
				<div aria-hidden="true" className="flex gap-3 px-4 py-3" key={row.id}>
					<Skeleton className="size-8 shrink-0" radius="pill" />
					<div className="flex min-w-0 flex-1 flex-col">
						<div className="flex h-5 items-center justify-between">
							<Skeleton className={cn("h-3", row.name)} radius="dense" />
							<Skeleton className="h-3 w-6" radius="dense" />
						</div>
						<div className="flex h-5 items-center">
							<Skeleton className={cn("h-3", row.line)} radius="dense" />
						</div>
						<div className="flex h-5 items-center">
							<Skeleton className="h-3 w-full" radius="dense" />
						</div>
					</div>
				</div>
			))}
		</div>
	);
}

/** The sort control: one quiet button that flips the order, "Newest ⇅". */
function DeskSortToggle({
	onSortChange,
	sort,
}: {
	onSortChange: (sort: DeskSort) => void;
	sort: DeskSort;
}) {
	const tl = useLiteralMessages();
	const next: DeskSort = sort === "newest" ? "oldest" : "newest";
	const hint =
		next === "newest" ? tl("Sort newest first") : tl("Sort oldest first");
	const sortedLabel =
		sort === "newest"
			? tl("Sorted newest first. {hint}", { hint })
			: tl("Sorted oldest first. {hint}", { hint });
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label={sortedLabel}
						className="gap-1.5 px-2"
						data-testid="desk-sort"
						onClick={() => onSortChange(next)}
						size="sm"
						variant="ghost-muted"
					/>
				}
			>
				{SORT_LABELS[sort]}
				<ArrowDownUp aria-hidden="true" className="size-3.5" />
			</TooltipTrigger>
			<TooltipContent side="bottom">{hint}</TooltipContent>
		</Tooltip>
	);
}

export interface DeskListProps {
	activeThreadId: string | null;
	/** A conversation is open, so the Details and Close shortcuts apply. */
	conversationOpen: boolean;
	cursorId: string | null;
	/** The user has moved the cursor, so it is marked apart from the open row. */
	cursorMoved: boolean;
	loading: boolean;
	now: number;
	onFocusRow: (threadId: string) => void;
	onKeyDownRow: (event: KeyboardEvent<HTMLElement>, threadId: string) => void;
	onOpen: (threadId: string) => void;
	onSortChange: (sort: DeskSort) => void;
	/** Null when the views rail header carries the New button instead. */
	onStart: (() => void) | null;
	registerRow: (threadId: string, element: HTMLElement | null) => void;
	rows: DeskRow[];
	sort: DeskSort;
	/** Touch-width layout: the keyboard legend does not apply. */
	stacked: boolean;
	view: DeskView | undefined;
	/** The narrow-width view picker, shown in place of the heading. */
	viewSelect: ReactNode | null;
}

/** The middle pane: the selected view's conversations as a keyboard listbox. */
export function DeskConversationList({
	activeThreadId,
	conversationOpen,
	cursorMoved,
	cursorId,
	loading,
	now,
	onFocusRow,
	onKeyDownRow,
	onOpen,
	onSortChange,
	onStart,
	registerRow,
	rows,
	sort,
	stacked,
	view,
	viewSelect,
}: DeskListProps) {
	const tl = useLiteralMessages();
	const label = view?.label ?? "Conversations";
	const listLabel = tl("{label} conversations", { label });
	const startLabel = deskStartLabel(view);
	const needsYou = rows.filter((row) => row.needsYou).length;
	const empty = deskEmptyCopy(view);
	const showSkeleton = loading && rows.length === 0;
	let summary = pluralize(rows.length, "conversation");
	if (needsYou > 0 && view?.id !== "needs-you") {
		summary += ` · ${needsYou} need${needsYou === 1 ? "s" : ""} you`;
	}

	return (
		<section
			aria-label={listLabel}
			className="flex min-h-0 w-full flex-col bg-background"
			data-testid="desk-list"
		>
			<header className="flex h-14 shrink-0 items-center gap-1 border-border border-b pr-2 pl-4">
				{viewSelect ?? (
					<h2 className="flex min-w-0 flex-1 items-baseline gap-2">
						<span className="truncate font-semibold text-foreground text-sm">
							{label}
						</span>
						<span
							aria-hidden="true"
							className="shrink-0 text-muted-foreground text-sm tabular-nums"
						>
							{showSkeleton ? "" : rows.length}
						</span>
					</h2>
				)}
				<p
					aria-live="polite"
					className="sr-only"
					data-testid="desk-list-summary"
				>
					{showSkeleton ? "Loading conversations" : summary}
				</p>
				<DeskSortToggle onSortChange={onSortChange} sort={sort} />
				{onStart ? (
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									aria-label={startLabel}
									data-testid="desk-new-conversation"
									onClick={onStart}
									size="icon-sm"
									variant="ghost-muted"
								/>
							}
						>
							<SquarePen aria-hidden="true" />
						</TooltipTrigger>
						<TooltipContent side="bottom">
							{startLabel} <Kbd>C</Kbd>
						</TooltipContent>
					</Tooltip>
				) : null}
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
				{showSkeleton ? <DeskSkeletonRows /> : null}
				{!loading && rows.length === 0 ? (
					<div
						className="flex flex-col gap-1 px-4 py-6"
						data-testid="desk-list-empty"
					>
						<p className="font-medium text-foreground text-sm">{empty.title}</p>
						<p className="text-pretty text-muted-foreground text-sm">
							{empty.description}
						</p>
					</div>
				) : null}
				{rows.length > 0 ? (
					<div
						aria-busy={loading}
						aria-label={listLabel}
						className="flex flex-col"
						data-testid="desk-rows"
						role="listbox"
					>
						{rows.map((row) => (
							<DeskListRow
								cursor={row.thread.id === cursorId}
								key={row.thread.id}
								marked={
									cursorMoved &&
									row.thread.id === cursorId &&
									row.thread.id !== activeThreadId
								}
								now={now}
								onFocusRow={onFocusRow}
								onKeyDownRow={onKeyDownRow}
								onOpen={onOpen}
								registerRow={registerRow}
								row={row}
								selected={row.thread.id === activeThreadId}
							/>
						))}
					</div>
				) : null}
			</div>

			{stacked ? null : (
				<footer
					aria-label="Keyboard shortcuts"
					className="flex h-10 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-border border-t px-4 text-foreground/70 text-xs"
				>
					{/* Move and Open only apply once there are rows to act on. */}
					{rows.length > 0 || loading ? (
						<>
							<span className="flex items-center gap-1.5">
								<KbdGroup>
									<Kbd className={LEGEND_KBD}>J</Kbd>
									<Kbd className={LEGEND_KBD}>K</Kbd>
								</KbdGroup>
								Move
							</span>
							<span className="flex items-center gap-1.5">
								<Kbd className={LEGEND_KBD}>
									<span aria-hidden="true">↵</span>
									<span className="sr-only">Enter</span>
								</Kbd>
								Open
							</span>
						</>
					) : null}
					{/* C stays listed on the New button's tooltip once a conversation
					    is open and the legend switches to that conversation's keys. */}
					{conversationOpen ? (
						<>
							<span className="flex items-center gap-1.5">
								<Kbd className={LEGEND_KBD}>I</Kbd>
								Details
							</span>
							<span className="flex items-center gap-1.5">
								<Kbd className={LEGEND_KBD}>Esc</Kbd>
								Close
							</span>
						</>
					) : (
						<span className="flex items-center gap-1.5">
							<Kbd className={LEGEND_KBD}>C</Kbd>
							New
						</span>
					)}
				</footer>
			)}
		</section>
	);
}
