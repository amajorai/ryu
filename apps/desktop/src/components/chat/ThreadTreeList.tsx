// apps/desktop/src/components/chat/ThreadTreeList.tsx
//
// The whole nest a thread sits in as one indented list: the root thread, the
// sessions it spawned, the sessions those spawned, and so on. It replaces the
// flat Sessions list of the thread bar.
//   - every row shows the run status, the title and the agent of its thread,
//     and opens that thread;
//   - a row with sessions below it folds and unfolds;
//   - the row of the open thread is marked.
// Keyboard, as in any tree: ArrowDown and ArrowUp move between rows, Home and
// End jump to the ends, the arrow that points forward in the reading direction
// unfolds a row or steps into it, the other one folds it or steps out to its
// parent, Enter or Space opens the thread.

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type KeyboardEvent, useMemo, useState } from "react";
import {
	RunStatusDot,
	readsRightToLeft,
} from "@/src/components/chat/ThreadHierarchyCrumbs.tsx";
import {
	flattenSubagentTree,
	type SubagentTreeNode,
	type SubagentTreeRow,
} from "@/src/lib/subagent-tree.ts";

type OpenConversation = (conversationId: string, title?: string) => void;
type TreeAction =
	| "first"
	| "in"
	| "last"
	| "next"
	| "open"
	| "out"
	| "previous";

const ROW_SELECTOR = "[data-tree-row]";
/** Each level is indented by this many pixels on the side reading starts. */
const INDENT = 14;
const KEY_ACTIONS: Record<string, TreeAction> = {
	" ": "open",
	ArrowDown: "next",
	ArrowLeft: "out",
	ArrowRight: "in",
	ArrowUp: "previous",
	End: "last",
	Enter: "open",
	Home: "first",
};

/** The short status word at the end of a row. */
function sessionStatusLabel(status: string | null): string {
	switch (status) {
		case "running":
			return "Running";
		case "failed":
			return "Failed";
		case "interrupted":
			return "Interrupted";
		case "completed":
			return "Done";
		default:
			return "Idle";
	}
}

/** What a key does on a row. Left and right swap where text reads right to left. */
function actionFor(key: string, rightToLeft: boolean): TreeAction | null {
	const action = KEY_ACTIONS[key] ?? null;
	if (rightToLeft && action === "in") {
		return "out";
	}
	if (rightToLeft && action === "out") {
		return "in";
	}
	return action;
}

function TreeRow({
	current,
	onAction,
	onFocus,
	onOpen,
	onToggle,
	row,
	tabStop,
}: {
	current: boolean;
	onAction: (action: TreeAction, element: HTMLElement) => void;
	onFocus: () => void;
	onOpen: () => void;
	onToggle: () => void;
	row: SubagentTreeRow;
	tabStop: boolean;
}) {
	const tl = useLiteralMessages();
	const { node } = row;
	const title = node.title ?? tl("Session");

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.target !== event.currentTarget ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey
		) {
			return;
		}
		const action = actionFor(event.key, readsRightToLeft(event.currentTarget));
		if (action) {
			event.preventDefault();
			onAction(action, event.currentTarget);
		}
	};

	return (
		<div
			aria-current={current ? "page" : undefined}
			aria-expanded={row.hasChildren ? row.expanded : undefined}
			aria-level={row.depth + 1}
			className={cn(
				"flex h-8 cursor-default items-center gap-1 rounded-lg pe-2 text-start text-sm transition-colors duration-150 hover:bg-muted hover:duration-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				current && "bg-muted font-medium"
			)}
			data-depth={row.depth}
			data-kind={node.kind}
			data-testid="thread-tree-row"
			data-tree-row={node.id}
			onClick={onOpen}
			onFocus={onFocus}
			onKeyDown={onKeyDown}
			role="treeitem"
			style={{ paddingInlineStart: 4 + row.depth * INDENT }}
			tabIndex={tabStop ? 0 : -1}
		>
			{row.hasChildren ? (
				<button
					aria-label={
						row.expanded
							? tl("Collapse {title}", { title })
							: tl("Expand {title}", { title })
					}
					className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
					data-testid="thread-tree-toggle"
					onClick={(event) => {
						event.stopPropagation();
						onToggle();
					}}
					tabIndex={-1}
					type="button"
				>
					<HugeiconsIcon
						className={cn(
							"size-3.5 transition-transform",
							!row.expanded && "-rotate-90 rtl:rotate-90"
						)}
						icon={ArrowDown01Icon}
						strokeWidth={2}
					/>
				</button>
			) : (
				<span aria-hidden="true" className="size-5 shrink-0" />
			)}
			<RunStatusDot status={node.status} />
			<span
				className="min-w-0 flex-1 truncate"
				data-ryu-i18n="off"
				title={title}
			>
				{title}
			</span>
			{node.agentName ? (
				<span
					className="max-w-24 shrink-0 truncate text-muted-foreground text-xs"
					data-ryu-i18n="off"
					data-testid="thread-tree-agent"
				>
					{node.agentName}
				</span>
			) : null}
			<span className="shrink-0 text-muted-foreground text-xs">
				{sessionStatusLabel(node.status)}
			</span>
		</div>
	);
}

export function ThreadTreeList({
	currentId,
	onOpenConversation,
	roots,
	truncated = false,
}: {
	/** The open thread, whose row is marked. */
	currentId: string;
	onOpenConversation: OpenConversation;
	roots: readonly SubagentTreeNode[];
	/** Core cut the tree at its level or thread limit. */
	truncated?: boolean;
}) {
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const rows = useMemo(
		() => flattenSubagentTree(roots, collapsed),
		[collapsed, roots]
	);
	// One row takes Tab: the one last focused, else the open thread, else the top.
	const tabStopId =
		[focusedId, currentId].find((id) =>
			rows.some((row) => row.node.id === id)
		) ?? rows[0]?.node.id;

	const toggle = (id: string) =>
		setCollapsed((previous) => {
			const next = new Set(previous);
			if (!next.delete(id)) {
				next.add(id);
			}
			return next;
		});

	const open = (node: SubagentTreeNode) =>
		onOpenConversation(node.conversationId, node.title ?? undefined);

	const act = (
		action: TreeAction,
		index: number,
		row: SubagentTreeRow,
		element: HTMLElement
	) => {
		const stops = [
			...(element.parentElement?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ??
				[]),
		];
		const parentIndex = rows.findIndex(
			(other) => other.node.id === row.node.parentId
		);
		switch (action) {
			case "open":
				open(row.node);
				break;
			case "next":
				stops[index + 1]?.focus();
				break;
			case "previous":
				stops[index - 1]?.focus();
				break;
			case "first":
				stops[0]?.focus();
				break;
			case "last":
				stops.at(-1)?.focus();
				break;
			case "in":
				if (row.expanded) {
					stops[index + 1]?.focus();
				} else if (row.hasChildren) {
					toggle(row.node.id);
				}
				break;
			default:
				if (row.expanded) {
					toggle(row.node.id);
				} else {
					stops[parentIndex]?.focus();
				}
		}
	};

	return (
		<div className="flex flex-col gap-1">
			<div
				aria-label="Session tree"
				className="flex max-h-80 flex-col overflow-y-auto"
				data-testid="thread-tree"
				role="tree"
			>
				{rows.map((row, index) => (
					<TreeRow
						current={row.node.id === currentId}
						key={row.node.id}
						onAction={(action, element) => act(action, index, row, element)}
						onFocus={() => setFocusedId(row.node.id)}
						onOpen={() => open(row.node)}
						onToggle={() => toggle(row.node.id)}
						row={row}
						tabStop={row.node.id === tabStopId}
					/>
				))}
			</div>
			{truncated ? (
				<p
					className="text-(length:--text-detail) px-2 text-muted-foreground"
					data-testid="thread-tree-truncated"
				>
					Showing part of this session tree. It is too large to list in full.
				</p>
			) : null}
		</div>
	);
}
