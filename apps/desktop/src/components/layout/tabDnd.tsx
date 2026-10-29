import { toast } from "@ryu/ui/components/sileo.tsx";
import {
	type ReorderShift,
	useReorderShift,
} from "@ryu/ui/hooks/use-reorder-shift.tsx";
import {
	createContext,
	type DragEvent,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { type Tab, useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { moveTabToWindow } from "@/src/lib/move-tab-window.ts";
import {
	canTearOutTab,
	readTabTransfer,
	TabTransferBlockedError,
} from "@/src/lib/tab-transfer.ts";
import { invokeWhenReady, isTauriReady } from "@/src/lib/tauri-ready.ts";
import { WORKBENCH_ITEM_DRAG_MIME } from "@/src/workbench/workbench-chrome.tsx";

/** Marker dataTransfer type so drop targets can tell a tab drag from an
    external drag (files, text) without reading the payload mid-drag. Workbench
    strips share it, so every tab surface speaks one drag format. */
export const TAB_DRAG_MIME = WORKBENCH_ITEM_DRAG_MIME;
/** A chat tab's durable identity, copied into another chat as an @ reference. */
export const CHAT_REFERENCE_DRAG_MIME = "application/x-ryu-chat-reference";

// Drag state for a tab chip/row, shared by the title-bar strip, the vertical
// sidebar list, and the content-area split drop zones. `draggingId` is the tab
// being dragged; `overId`/`dropBefore` mark which strip tab is hovered and on
// which side the dragged tab will land. Tabs beside the landing spot slide
// apart to preview it (`shift`, one per axis); a drop line is only drawn where
// that preview cannot reach, such as a drop into another bracket. `canDrop`
// gates strip drops to tabs of the same pinned-state (pinned tabs reorder within their block,
// unpinned within theirs) since `normalize` would otherwise snap a cross-block
// drop back anyway.
export interface TabDnd {
	canDrop: (targetId: string) => boolean;
	draggingId: string | null;
	dropBefore: boolean;
	moveToWindow: (id: string, dragOut?: boolean) => Promise<void>;
	onDrop: (id: string) => void;
	onEnd: (event?: DragEvent) => void;
	onOver: (id: string, before: boolean) => void;
	onStart: (id: string) => void;
	overId: string | null;
	shift: Record<"x" | "y", ReorderShift>;
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
	const { tabs, moveTab, closeTab } = useTabsContext();
	const activeDrag = useRef<string | null>(null);
	const dragRevision = useRef(0);
	const cancelled = useRef(false);
	const moving = useRef(new Set<string>());
	const currentTabs = useRef(tabs);
	currentTabs.current = tabs;
	const [draggingId, setDraggingId] = useState<string | null>(null);
	const [overId, setOverId] = useState<string | null>(null);
	const [dropBefore, setDropBefore] = useState(true);
	const reorderTarget = {
		activeId: draggingId,
		before: dropBefore,
		overId: draggingId && canDropOn(draggingId, overId) ? overId : null,
	};
	const shiftX = useReorderShift({ ...reorderTarget, axis: "x" });
	const shiftY = useReorderShift({ ...reorderTarget, axis: "y" });

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				cancelled.current = true;
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => {
			activeDrag.current = null;
			window.removeEventListener("keydown", onKeyDown, true);
		};
	}, []);

	useEffect(() => {
		if (!readTabTransfer()) {
			return;
		}
		// Layout and its tab tree have committed. A source is never removed just
		// because the native process managed to allocate a blank window.
		const timer = setTimeout(() => {
			void invokeWhenReady("tab_transfer_ready").catch(() => {
				// The native timeout closes this unacknowledged destination and the
				// source reports the failure with its tab still intact.
			});
		});
		return () => clearTimeout(timer);
	}, []);

	const moveToWindow = async (id: string, dragOut = false) => {
		const tab = currentTabs.current.find((candidate) => candidate.id === id);
		if (!tab || moving.current.has(id) || !isTauriReady()) {
			return;
		}
		moving.current.add(id);
		try {
			const moved = await moveTabToWindow(tab, dragOut);
			const current = currentTabs.current.find(
				(candidate) => candidate.id === id
			);
			if (
				moved &&
				current?.path === tab.path &&
				current?.conversationId === tab.conversationId &&
				current?.navToken === tab.navToken
			) {
				closeTab(id, { transferred: true });
			}
		} catch (error) {
			console.error("Tab window transfer failed", error);
			toast.error(
				error instanceof TabTransferBlockedError
					? error.message
					: "Couldn't move this tab. It is still open in this window."
			);
		} finally {
			moving.current.delete(id);
		}
	};

	function canDropOn(dragId: string, targetId: string | null): boolean {
		if (!targetId || dragId === targetId) {
			return false;
		}
		const dragged = tabs.find((t) => t.id === dragId);
		const target = tabs.find((t) => t.id === targetId);
		// Keep pinned tabs reordering within the pinned block and unpinned within
		// theirs — a cross-block drop would just be snapped back by normalize.
		return (
			!!dragged &&
			!!target &&
			Boolean(dragged.pinned) === Boolean(target.pinned)
		);
	}

	const canDrop = (targetId: string): boolean =>
		!!draggingId && canDropOn(draggingId, targetId);

	const reset = () => {
		activeDrag.current = null;
		setDraggingId(null);
		setOverId(null);
	};

	const value: TabDnd = {
		draggingId,
		overId,
		dropBefore,
		onStart: (id) => {
			cancelled.current = false;
			activeDrag.current = id;
			setDraggingId(id);
			const revision = ++dragRevision.current;
			if (isTauriReady()) {
				void invokeWhenReady<boolean | null>("watch_tab_drag")
					.then((outside) => {
						if (outside === null) {
							return;
						}
						// Give dragend/drop handlers precedence, especially external chat
						// reference copies. Only recover an otherwise stranded native drag.
						setTimeout(() => {
							if (
								activeDrag.current !== id ||
								dragRevision.current !== revision
							) {
								return;
							}
							reset();
							if (outside && !cancelled.current) {
								void moveToWindow(id, true);
							}
						}, 150);
					})
					.catch(() => {
						/* Older native hosts keep their normal DOM drag path. */
					});
			}
		},
		onEnd: (event) => {
			const id = activeDrag.current;
			reset();
			if (
				id &&
				event &&
				canTearOutTab(
					event.dataTransfer.dropEffect,
					event.buttons,
					cancelled.current
				)
			) {
				void moveToWindow(id, true);
			}
		},
		moveToWindow,
		onOver: (id, before) => {
			setOverId((prev) => (prev === id ? prev : id));
			setDropBefore((prev) => (prev === before ? prev : before));
		},
		onDrop: (id) => {
			// The dragged tab slides into the gap under the pointer, so a drop on
			// it lands on the target it is previewing.
			const targetId = id === draggingId ? overId : id;
			if (draggingId && targetId && canDrop(targetId)) {
				moveTab(draggingId, targetId, dropBefore);
			}
			reset();
		},
		canDrop,
		shift: { x: shiftX, y: shiftY },
	};

	return (
		<TabDndContext.Provider value={value}>{children}</TabDndContext.Provider>
	);
}

/** Which run of tabs a chip slides within. The strip brackets tab groups and
    splits, so their members only shift inside the bracket while the bracket
    itself shifts as one item among the loose tabs (see {@link
    useTabBracketShift}); the vertical list brackets only splits. */
function tabShiftGroup(tab: Tab | undefined, axis: "x" | "y"): string {
	if (tab?.pinned) {
		return "pinned";
	}
	if (tab?.splitId) {
		return `split:${tab.splitId}`;
	}
	if (axis === "x" && tab?.groupId) {
		return `group:${tab.groupId}`;
	}
	return "loose";
}

/** Ref + style for a bracket (tab group or split) so it slides as one item
    when a loose tab is dragged past it. */
export function useTabBracketShift(bracketId: string, axis: "x" | "y" = "x") {
	const { shift } = useTabDnd();
	const id = `bracket:${bracketId}`;
	return {
		ref: shift[axis].register(id, "loose"),
		style: shift[axis].styleFor(id),
	};
}

/** Shared drag handlers + indicator flags for a single draggable tab chip/row.
    Keeps the dragstart/dragover/drop wiring in one place so the strip chips
    and the vertical rows stay in sync. `axis` picks which midpoint decides the
    before/after side: "x" for the horizontal strip, "y" for vertical rows.
    Spread `shiftProps` on the element that should slide aside during a drag. */
export function useTabDragProps(tabId: string, axis: "x" | "y" = "x") {
	const dnd = useTabDnd();
	const { tabs } = useTabsContext();
	const shift = dnd.shift[axis];
	const isDragging = dnd.draggingId === tabId;
	const isOver = dnd.overId === tabId && dnd.draggingId !== tabId;
	// Neighbours sliding apart is the indicator; the line is only the fallback.
	const showLine = isOver && !shift.previewing;
	return {
		isDragging,
		showBefore: showLine && dnd.dropBefore,
		showAfter: showLine && !dnd.dropBefore,
		shiftProps: {
			ref: shift.register(
				tabId,
				tabShiftGroup(
					tabs.find((candidate) => candidate.id === tabId),
					axis
				)
			),
			style: shift.styleFor(tabId),
		},
		dragHandlers: {
			draggable: true,
			onDragStart: (e: DragEvent) => {
				e.dataTransfer.effectAllowed = "copyMove";
				e.dataTransfer.setData("text/plain", tabId);
				e.dataTransfer.setData(TAB_DRAG_MIME, tabId);
				const tab = tabs.find((candidate) => candidate.id === tabId);
				if (tab?.conversationId) {
					e.dataTransfer.setData(
						CHAT_REFERENCE_DRAG_MIME,
						JSON.stringify({ id: tab.conversationId, label: tab.title })
					);
				}
				dnd.onStart(tabId);
			},
			onDragEnd: (event: DragEvent) => dnd.onEnd(event),
			onDragOver: (e: DragEvent) => {
				if (dnd.draggingId === tabId && dnd.overId && shift.previewing) {
					// The dragged tab has slid into the gap under the pointer: keep
					// the current target (re-targeting here would close the gap and
					// flicker) and accept the drop for it. Without a slide preview
					// (a line into another bracket) the tab has not moved, so a drop
					// back on itself stays a no-op.
					e.preventDefault();
					e.stopPropagation();
					e.dataTransfer.dropEffect = "move";
					return;
				}
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
