import {
	createContext,
	type DragEvent,
	type ReactNode,
	useContext,
	useState,
} from "react";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";

/** Marker dataTransfer type so drop targets can tell a tab drag from an
    external drag (files, text) without reading the payload mid-drag. */
export const TAB_DRAG_MIME = "application/x-ryu-tab";

// Drag state for a tab chip/row, shared by the title-bar strip, the vertical
// sidebar list, and the content-area split drop zones. `draggingId` is the tab
// being dragged; `overId`/`dropBefore` mark which strip tab is hovered and on
// which side the reorder indicator should draw. `canDrop` gates strip drops to
// tabs of the same pinned-state (pinned tabs reorder within their block,
// unpinned within theirs) since `normalize` would otherwise snap a cross-block
// drop back anyway.
export interface TabDnd {
	canDrop: (targetId: string) => boolean;
	draggingId: string | null;
	dropBefore: boolean;
	onDrop: (id: string) => void;
	onEnd: () => void;
	onOver: (id: string, before: boolean) => void;
	onStart: (id: string) => void;
	overId: string | null;
}

const TabDndContext = createContext<TabDnd | null>(null);

export function useTabDnd(): TabDnd {
	const ctx = useContext(TabDndContext);
	if (!ctx) {
		throw new Error("useTabDnd must be used inside TabDndProvider");
	}
	return ctx;
}

/** Owns the drag state for every tab drag surface. Mounted once in Layout so
    the strip, the vertical tab list, and the split drop zones all see the same
    drag. */
export function TabDndProvider({ children }: { children: ReactNode }) {
	const { tabs, moveTab, removeFromSplit } = useTabsContext();
	const [draggingId, setDraggingId] = useState<string | null>(null);
	const [overId, setOverId] = useState<string | null>(null);
	const [dropBefore, setDropBefore] = useState(true);

	const canDrop = (targetId: string): boolean => {
		if (!draggingId || draggingId === targetId) {
			return false;
		}
		const dragged = tabs.find((t) => t.id === draggingId);
		const target = tabs.find((t) => t.id === targetId);
		// Keep pinned tabs reordering within the pinned block and unpinned within
		// theirs — a cross-block drop would just be snapped back by normalize.
		return (
			!!dragged &&
			!!target &&
			Boolean(dragged.pinned) === Boolean(target.pinned)
		);
	};

	const reset = () => {
		setDraggingId(null);
		setOverId(null);
	};

	const value: TabDnd = {
		draggingId,
		overId,
		dropBefore,
		onStart: setDraggingId,
		onEnd: reset,
		onOver: (id, before) => {
			setOverId((prev) => (prev === id ? prev : id));
			setDropBefore((prev) => (prev === before ? prev : before));
		},
		onDrop: (id) => {
			if (draggingId && canDrop(id)) {
				const dragged = tabs.find((t) => t.id === draggingId);
				const target = tabs.find((t) => t.id === id);
				moveTab(draggingId, id, dropBefore);
				// Dragging a pane's chip OUT of its split bracket (dropping on a tab
				// that isn't a sibling) pulls it out of the split — the drag-out-to-
				// unsplit gesture. Dropping between siblings just reorders the panes'
				// strip chips.
				if (dragged?.splitId && dragged.splitId !== target?.splitId) {
					removeFromSplit(draggingId);
				}
			}
			reset();
		},
		canDrop,
	};

	return (
		<TabDndContext.Provider value={value}>{children}</TabDndContext.Provider>
	);
}

/** Shared drag handlers + indicator flags for a single draggable tab chip/row.
    Keeps the dragstart/dragover/drop wiring in one place so the strip chips
    and the vertical rows stay in sync. `axis` picks which midpoint decides the
    before/after side: "x" for the horizontal strip, "y" for vertical rows. */
export function useTabDragProps(tabId: string, axis: "x" | "y" = "x") {
	const dnd = useTabDnd();
	const isDragging = dnd.draggingId === tabId;
	const isOver = dnd.overId === tabId && dnd.draggingId !== tabId;
	return {
		isDragging,
		showBefore: isOver && dnd.dropBefore,
		showAfter: isOver && !dnd.dropBefore,
		dragHandlers: {
			draggable: true,
			onDragStart: (e: DragEvent) => {
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", tabId);
				e.dataTransfer.setData(TAB_DRAG_MIME, tabId);
				dnd.onStart(tabId);
			},
			onDragEnd: () => dnd.onEnd(),
			onDragOver: (e: DragEvent) => {
				if (
					!dnd.draggingId ||
					dnd.draggingId === tabId ||
					!dnd.canDrop(tabId)
				) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				e.dataTransfer.dropEffect = "move";
				const rect = e.currentTarget.getBoundingClientRect();
				dnd.onOver(
					tabId,
					axis === "x"
						? e.clientX < rect.left + rect.width / 2
						: e.clientY < rect.top + rect.height / 2
				);
			},
			onDrop: (e: DragEvent) => {
				if (!dnd.draggingId) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				dnd.onDrop(tabId);
			},
		},
	};
}
