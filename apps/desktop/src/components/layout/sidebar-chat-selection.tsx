// Multi-select, cross-section drag, and bulk actions for sidebar chat rows.
//
// Selection is a module-level store rather than sidebar state because the same
// rows also render inside portalled overflow popovers, and each row only needs to
// know whether IT is selected — a selector per row keeps a shift-click from
// re-rendering every chat in the sidebar.
//
// Gestures (Finder-style):
//   - Shift-click selects the visible range from the anchor (the last clicked
//     row, or the open chat) to the clicked row, within the clicked row's surface
//     ({@link SIDEBAR_CHAT_SCOPE_ATTRIBUTES}: one sidebar panel, or one overflow
//     popover). Collapsed sections are skipped because their rows are not in the
//     DOM.
//   - Up/Down arrows move focus between rows; Shift+Up/Down extends the
//     selection from the anchor, like shift-click.
//   - Cmd/Ctrl-click toggles one row. The first toggle also selects the open
//     chat, so "open A, Cmd-click B" selects both.
//   - A plain click, or Escape, clears the selection.
//   - Dragging a selected row drags the whole selection; dragging any other row
//     drags just that row.
//
// AppSidebar owns what a drop or a bulk action MEANS (pin, archive, move to a
// project) and hands it to rows and sections as {@link SidebarChatBulkActions}.

import type {
	DragEvent as ReactDragEvent,
	KeyboardEvent as ReactKeyboardEvent,
	MouseEvent as ReactMouseEvent,
} from "react";
import { useEffect, useState } from "react";
import {
	clearSidebarChatSelection,
	EMPTY_SELECTION,
	useSidebarChatSelection,
} from "./sidebar-chat-selection-store.ts";
import {
	enclosingVirtualChatRows,
	sidebarVirtualChatRows,
	VIRTUAL_LIST_SELECTOR,
} from "./sidebar-chat-virtual-registry.ts";

export {
	SidebarChatBulkContextMenuContent,
	SidebarChatBulkDeleteDialog,
} from "./sidebar-chat-selection-bulk-menu.tsx";
export {
	clearSidebarChatSelection,
	useSidebarChatSelection,
} from "./sidebar-chat-selection-store.ts";

/** Drag format carrying the ids of every chat being dragged, as JSON. Distinct
 *  from the visibility payload (one chat) and the section-reorder drag. */
export const SIDEBAR_CHATS_DND_MIME = "application/x-ryu-sidebar-chats";

const ROW_ID_ATTRIBUTE = "data-sidebar-chat-id";
const ROW_SCOPE_ATTRIBUTE = "data-sidebar-chat-scope";
const ROW_SCOPE_SELECTOR = `[${ROW_SCOPE_ATTRIBUTE}]`;

/** Marks one surface (a sidebar panel's list, an overflow popover's list) as
 *  the range a shift-click selects over, so a second mounted sidebar or a
 *  portalled popover never joins the range. */
export const SIDEBAR_CHAT_SCOPE_ATTRIBUTES = { [ROW_SCOPE_ATTRIBUTE]: "" };

/** Where a dropped chat should end up. */
export type SidebarChatDropTarget =
	| { kind: "archived" }
	| { kind: "chats" }
	/** Re-file under a folder (`null` = no project) without touching pin/archive. */
	| { kind: "folder"; folderPath: string | null }
	| { kind: "pinned" }
	| { kind: "project"; folderPath: string; sourceFolders: readonly string[] };

/** A section or sub-section that accepts dragged chats. */
export interface ChatMoveDrop {
	/** Whether dropping these ids would change anything; a no-op target shows the
	 *  no-drop cursor instead of a highlight. */
	accepts: (ids: readonly string[]) => boolean;
	onDrop: (ids: string[]) => void;
}

export interface SidebarChatBulkProject {
	label: string;
	path: string;
}

/** Sidebar-owned meaning of each bulk gesture, threaded through ChatRowHandlers. */
export interface SidebarChatBulkActions {
	deleteMany: (ids: readonly string[]) => void;
	/** Build the drop handler for one section or project. */
	dropTarget: (target: SidebarChatDropTarget) => ChatMoveDrop;
	moveToProject: (ids: readonly string[], folderPath: string | null) => void;
	openInNewTabs: (ids: readonly string[]) => void;
	projects: readonly SidebarChatBulkProject[];
	setArchived: (ids: readonly string[], archived: boolean) => void;
	setPinned: (ids: readonly string[], pinned: boolean) => void;
	setRead: (ids: readonly string[], read: boolean) => void;
}

function rowRoot(element: Element): ParentNode {
	return element.closest(ROW_SCOPE_SELECTOR) ?? element.ownerDocument;
}

/** Every chat row id under the same scope as `element`, in visual order. A
 *  virtualized list contributes all of its rows, mounted or not. */
export function orderedSidebarChatIds(element: Element): string[] {
	const root = rowRoot(element);
	const ids: string[] = [];
	const seen = new Set<string>();
	const push = (id: string | null) => {
		if (id && !seen.has(id)) {
			seen.add(id);
			ids.push(id);
		}
	};
	for (const node of root.querySelectorAll(
		`[${ROW_ID_ATTRIBUTE}], ${VIRTUAL_LIST_SELECTOR}`
	)) {
		if (enclosingVirtualChatRows(node)) {
			continue;
		}
		const virtual = sidebarVirtualChatRows(node);
		if (virtual) {
			for (const id of virtual.orderedIds()) {
				push(id);
			}
			continue;
		}
		push(node.getAttribute(ROW_ID_ATTRIBUTE));
	}
	return ids;
}

/** The mounted chat row ids inside `element`, in visual order. */
export function sidebarChatRowIdsWithin(element: Element): string[] {
	return Array.from(
		element.querySelectorAll(`[${ROW_ID_ATTRIBUTE}]`),
		(row) => row.getAttribute(ROW_ID_ATTRIBUTE) ?? ""
	).filter(Boolean);
}

/** Focus the row for `id`, scrolling a virtualized list to it when the row is
 *  not mounted yet. */
function focusSidebarChatRow(root: ParentNode, id: string): void {
	const row = root.querySelector<HTMLElement>(
		`[${ROW_ID_ATTRIBUTE}="${CSS.escape(id)}"]`
	);
	if (row) {
		row.focus();
		return;
	}
	for (const list of root.querySelectorAll(VIRTUAL_LIST_SELECTOR)) {
		const virtual = sidebarVirtualChatRows(list);
		if (virtual?.orderedIds().includes(id)) {
			virtual.reveal(id);
			return;
		}
	}
}

/** DOM attributes a chat row carries so range selection can find it. */
export function sidebarChatRowAttributes(id: string, selected: boolean) {
	return {
		[ROW_ID_ATTRIBUTE]: id,
		"data-selected": selected ? "true" : undefined,
	};
}

/**
 * Apply a row click to the selection. Returns true when the click was a
 * selection gesture (shift / cmd / ctrl) and must not open the chat.
 */
export function applySidebarChatSelectionClick(
	event: ReactMouseEvent<HTMLElement>,
	id: string,
	activeId: string | null
): boolean {
	const state = useSidebarChatSelection.getState();
	const additive = event.metaKey || event.ctrlKey;
	if (event.shiftKey) {
		const ordered = orderedSidebarChatIds(event.currentTarget);
		let anchor = id;
		if (state.anchorId && ordered.includes(state.anchorId)) {
			anchor = state.anchorId;
		} else if (activeId && ordered.includes(activeId)) {
			anchor = activeId;
		}
		selectRange(ordered, anchor, id, additive);
		return true;
	}
	if (additive) {
		const selectedIds = new Set(state.selectedIds);
		if (
			selectedIds.size === 0 &&
			activeId &&
			activeId !== id &&
			orderedSidebarChatIds(event.currentTarget).includes(activeId)
		) {
			selectedIds.add(activeId);
		}
		if (selectedIds.has(id)) {
			selectedIds.delete(id);
		} else {
			selectedIds.add(id);
		}
		useSidebarChatSelection.setState({ anchorId: id, selectedIds });
		return true;
	}
	useSidebarChatSelection.setState({
		anchorId: id,
		selectedIds: EMPTY_SELECTION,
	});
	return false;
}

/** Select the visual range between `anchor` and `target` (inclusive). */
function selectRange(
	ordered: readonly string[],
	anchor: string,
	target: string,
	additive: boolean
): void {
	const state = useSidebarChatSelection.getState();
	const from = ordered.indexOf(anchor);
	const to = ordered.indexOf(target);
	const range =
		from < 0 || to < 0
			? [target]
			: ordered.slice(Math.min(from, to), Math.max(from, to) + 1);
	const selectedIds = additive
		? new Set([...state.selectedIds, ...range])
		: new Set(range);
	useSidebarChatSelection.setState({ anchorId: anchor, selectedIds });
}

/**
 * Up/Down on a focused row moves focus to the neighbouring row; with Shift it
 * also extends the selection from the anchor (the row where the run started).
 * Returns true when the key was handled.
 */
export function applySidebarChatArrowKey(
	event: ReactKeyboardEvent<HTMLElement>,
	id: string
): boolean {
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
		return false;
	}
	event.preventDefault();
	const ordered = orderedSidebarChatIds(event.currentTarget);
	const index = ordered.indexOf(id);
	const nextId = ordered[index + (event.key === "ArrowDown" ? 1 : -1)];
	if (index < 0 || !nextId) {
		return true;
	}
	focusSidebarChatRow(rowRoot(event.currentTarget), nextId);
	if (event.shiftKey) {
		const state = useSidebarChatSelection.getState();
		// A fresh keyboard run starts at the focused row; an existing selection
		// keeps extending from its anchor.
		const anchor =
			state.selectedIds.size > 0 &&
			state.anchorId &&
			ordered.includes(state.anchorId)
				? state.anchorId
				: id;
		selectRange(ordered, anchor, nextId, false);
	}
	return true;
}

/** The ids a drag of `primaryId` carries: the selection when it includes the
 *  row (in visual order), otherwise just the row. */
function idsForDragOf(primaryId: string, element: Element): string[] {
	const { selectedIds } = useSidebarChatSelection.getState();
	if (!selectedIds.has(primaryId) || selectedIds.size < 2) {
		return [primaryId];
	}
	const ordered = orderedSidebarChatIds(element).filter((id) =>
		selectedIds.has(id)
	);
	const visible = new Set(ordered);
	return [...ordered, ...[...selectedIds].filter((id) => !visible.has(id))];
}

/** Ids a visibility-payload drop of `primaryId` should apply to. */
export function draggedSidebarChatIds(primaryId: string): string[] {
	const { draggingIds } = useSidebarChatSelection.getState();
	return draggingIds.includes(primaryId) ? [...draggingIds] : [primaryId];
}

function setCountDragImage(
	event: ReactDragEvent<HTMLElement>,
	count: number
): void {
	const ghost = document.createElement("div");
	ghost.textContent = `${count} chats`;
	ghost.className =
		"fixed -top-96 left-0 rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground text-xs shadow-md";
	document.body.append(ghost);
	event.dataTransfer.setDragImage(ghost, 12, 12);
	setTimeout(() => ghost.remove(), 0);
}

/** Add the multi-chat payload to a row's dragstart. */
export function startSidebarChatDrag(
	event: ReactDragEvent<HTMLElement>,
	id: string
): void {
	const ids = idsForDragOf(id, event.currentTarget);
	if (ids.length === 1) {
		clearSidebarChatSelection();
	}
	event.dataTransfer.setData(SIDEBAR_CHATS_DND_MIME, JSON.stringify({ ids }));
	if (ids.length > 1) {
		setCountDragImage(event, ids.length);
	}
	// Defer the store update: re-rendering the sidebar synchronously inside
	// dragstart (an empty Pinned section appearing) can cancel the drag.
	setTimeout(() => {
		useSidebarChatSelection.setState({ dragging: true, draggingIds: ids });
	}, 0);
	watchSidebarChatDragEnd(event.currentTarget.ownerDocument.defaultView);
}

export function endSidebarChatDrag(): void {
	setTimeout(() => {
		useSidebarChatSelection.setState({ dragging: false });
	}, 0);
}

let stopWatchingDragEnd: (() => void) | null = null;

/**
 * End the drag from the window as well as from the source row. A successful
 * move (pin, archive, project) re-renders the dragged row into another list and
 * removes its DOM node before `dragend` fires, so that event never reaches the
 * row's React handler and empty drop targets would linger. `drop` still fires
 * on the mounted target, and a window-level `dragend` covers a cancelled drag.
 */
function watchSidebarChatDragEnd(view: Window | null): void {
	stopWatchingDragEnd?.();
	if (!view) {
		return;
	}
	const finish = () => {
		stopWatchingDragEnd?.();
		endSidebarChatDrag();
	};
	view.addEventListener("drop", finish, { capture: true });
	view.addEventListener("dragend", finish, { capture: true });
	stopWatchingDragEnd = () => {
		view.removeEventListener("drop", finish, { capture: true });
		view.removeEventListener("dragend", finish, { capture: true });
		stopWatchingDragEnd = null;
	};
}

function hasSidebarChatDrag(dataTransfer: DataTransfer): boolean {
	return dataTransfer.types.includes(SIDEBAR_CHATS_DND_MIME);
}

/** Parse a drop's chat ids; null when the drop is not a sidebar chat drag. */
export function readSidebarChatDrag(
	dataTransfer: DataTransfer
): string[] | null {
	const raw = dataTransfer.getData(SIDEBAR_CHATS_DND_MIME);
	if (!raw) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"ids" in parsed &&
			Array.isArray(parsed.ids)
		) {
			const ids = parsed.ids.filter(
				(value: unknown): value is string =>
					typeof value === "string" && value.length > 0
			);
			return ids.length > 0 ? ids : null;
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * Drop-target wiring for a section or sub-section. Each handler returns true when
 * it handled the event, so callers can fall through to their own drag logic
 * (section reorder, visibility) otherwise.
 */
export function useChatMoveDropTarget(chatDrop: ChatMoveDrop | undefined) {
	const [isOver, setIsOver] = useState(false);
	const dragging = useSidebarChatSelection((state) => state.dragging);
	useEffect(() => {
		if (!dragging) {
			setIsOver(false);
		}
	}, [dragging]);

	const onDragOver = (event: ReactDragEvent<HTMLElement>): boolean => {
		if (!(chatDrop && hasSidebarChatDrag(event.dataTransfer))) {
			return false;
		}
		event.stopPropagation();
		const { draggingIds } = useSidebarChatSelection.getState();
		// `draggingIds` lands a tick after dragstart; until then, allow the drop.
		const allowed = draggingIds.length === 0 || chatDrop.accepts(draggingIds);
		if (allowed) {
			event.preventDefault();
		}
		event.dataTransfer.dropEffect = allowed ? "move" : "none";
		setIsOver(allowed);
		return true;
	};

	const onDragLeave = (event: ReactDragEvent<HTMLElement>) => {
		const related = event.relatedTarget;
		if (!(related instanceof Node && event.currentTarget.contains(related))) {
			setIsOver(false);
		}
	};

	const onDrop = (event: ReactDragEvent<HTMLElement>): boolean => {
		if (!chatDrop) {
			return false;
		}
		const ids = readSidebarChatDrag(event.dataTransfer);
		if (!ids) {
			return false;
		}
		event.preventDefault();
		event.stopPropagation();
		setIsOver(false);
		clearSidebarChatSelection();
		if (chatDrop.accepts(ids)) {
			chatDrop.onDrop(ids);
		}
		return true;
	};

	return { isOver, onDragLeave, onDragOver, onDrop };
}

/** Clear the selection on Escape while anything is selected. */
export function useSidebarChatSelectionEscape(): void {
	const hasSelection = useSidebarChatSelection(
		(state) => state.selectedIds.size > 0
	);
	useEffect(() => {
		if (!hasSelection) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				clearSidebarChatSelection();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [hasSelection]);
}
