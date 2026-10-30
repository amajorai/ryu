// Module-level selection store for sidebar chat rows; see
// sidebar-chat-selection.tsx for the gestures it backs.

import { create } from "zustand";

interface SidebarChatSelectionState {
	/** The fixed end of a shift-click range. */
	anchorId: string | null;
	/** True while a chat row drag is in flight, so empty drop targets can show. */
	dragging: boolean;
	/** The ids of the most recent row drag (kept after dragend for late drops). */
	draggingIds: readonly string[];
	/** Ids awaiting the bulk delete confirmation, or null when it is closed. */
	pendingDeleteIds: readonly string[] | null;
	selectedIds: ReadonlySet<string>;
}

export const EMPTY_SELECTION: ReadonlySet<string> = new Set();

export const useSidebarChatSelection = create<SidebarChatSelectionState>(
	() => ({
		anchorId: null,
		dragging: false,
		draggingIds: [],
		pendingDeleteIds: null,
		selectedIds: EMPTY_SELECTION,
	})
);

export function clearSidebarChatSelection(): void {
	if (useSidebarChatSelection.getState().selectedIds.size === 0) {
		return;
	}
	useSidebarChatSelection.setState({ selectedIds: EMPTY_SELECTION });
}
