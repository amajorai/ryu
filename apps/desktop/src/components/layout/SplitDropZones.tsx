import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties, DragEvent } from "react";
import { useState } from "react";
import { findSplit, useTabsContext } from "@/src/contexts/TabsContext.tsx";
import type { SplitDirection } from "@/src/lib/splitTree.ts";
import {
	computeSplitLayout,
	FULL_PANE_RECT,
	type PaneRect,
	paneRectPx,
} from "./SplitView.tsx";
import { useTabDnd } from "./tabDnd.tsx";

// The titlebar overlays the top 48px of the content area; the overlay starts
// below it so drags over the strip keep hitting the strip's own targets.
const TITLEBAR_PX = 48;

// Cursor bands inside a pane: the middle CENTER_BAND (per axis) reads as the
// center zone, the rest picks the nearest edge.
const CENTER_BAND = 0.5;

interface HoverZone {
	tabId: string;
	zone: SplitDirection | "center";
}

interface PxRect {
	height: number;
	left: number;
	top: number;
	width: number;
}

/** The half (or whole, for center/swap) of the hovered pane the drop would
    occupy — the live split preview. */
function previewRect(pane: PxRect, zone: SplitDirection | "center"): PxRect {
	switch (zone) {
		case "left":
			return { ...pane, width: pane.width / 2 };
		case "right":
			return {
				...pane,
				left: pane.left + pane.width / 2,
				width: pane.width / 2,
			};
		case "up":
			return { ...pane, height: pane.height / 2 };
		case "down":
			return {
				...pane,
				top: pane.top + pane.height / 2,
				height: pane.height / 2,
			};
		default:
			return pane;
	}
}

function zoneForCursor(
	x: number,
	y: number,
	pane: PxRect,
	centerAllowed: boolean
): SplitDirection | "center" {
	// Normalized cursor position inside the pane, 0..1 per axis.
	const nx = (x - pane.left) / Math.max(1, pane.width);
	const ny = (y - pane.top) / Math.max(1, pane.height);
	const margin = (1 - CENTER_BAND) / 2;
	const inCenter =
		nx > margin && nx < 1 - margin && ny > margin && ny < 1 - margin;
	if (inCenter && centerAllowed) {
		return "center";
	}
	// Nearest edge by normalized distance, so wide panes still split top/bottom
	// near their horizontal edges.
	const distances: [SplitDirection, number][] = [
		["left", nx],
		["right", 1 - nx],
		["up", ny],
		["down", 1 - ny],
	];
	distances.sort((a, b) => a[1] - b[1]);
	return distances[0][0];
}

/** Warp-style drop zones over the visible panes while a tab is being dragged:
    hovering a pane edge previews the split that dropping would create (the
    highlighted half IS the suggestion), the center swaps two panes of an open
    split. Dropping calls `splitPane`/`swapSplitPanes`. Rendered only during a
    tab drag, so it never intercepts normal pointer traffic. */
export function SplitDropZones({
	containerRef,
}: {
	containerRef: React.RefObject<HTMLElement | null>;
}) {
	const dnd = useTabDnd();
	const { tabs, splits, activeTabId, splitPane, swapSplitPanes } =
		useTabsContext();
	const [hover, setHover] = useState<HoverZone | null>(null);

	const draggingId = dnd.draggingId;
	if (!draggingId) {
		return null;
	}

	// The panes currently on screen: the active split's tiles, else the single
	// focused pane filling the content area.
	const activeSplit = findSplit(tabs, splits, activeTabId);
	const paneRects = new Map<string, PaneRect>();
	if (activeSplit) {
		for (const [id, rect] of computeSplitLayout(activeSplit.root).panes) {
			paneRects.set(id, rect);
		}
	} else if (activeTabId) {
		paneRects.set(activeTabId, FULL_PANE_RECT);
	}
	// No usable drop target: nothing visible, or only the dragged tab itself is
	// on screen with nothing to split against.
	paneRects.delete(draggingId);
	if (paneRects.size === 0) {
		return null;
	}

	const draggedInActiveSplit =
		!!activeSplit &&
		tabs.find((t) => t.id === draggingId)?.splitId === activeSplit.id;

	const pxRects = (): Map<string, PxRect> | null => {
		const el = containerRef.current;
		if (!el) {
			return null;
		}
		const box = el.getBoundingClientRect();
		const out = new Map<string, PxRect>();
		for (const [id, rect] of paneRects) {
			out.set(id, paneRectPx(rect, { width: box.width, height: box.height }));
		}
		return out;
	};

	const hitTest = (e: DragEvent): HoverZone | null => {
		const el = containerRef.current;
		const rects = pxRects();
		if (!(el && rects)) {
			return null;
		}
		const box = el.getBoundingClientRect();
		const x = e.clientX - box.left;
		const y = e.clientY - box.top;
		for (const [tabId, pane] of rects) {
			if (
				x >= pane.left &&
				x <= pane.left + pane.width &&
				y >= pane.top &&
				y <= pane.top + pane.height
			) {
				// Center = swap, only meaningful between two panes of the open split.
				const centerAllowed = draggedInActiveSplit;
				return { tabId, zone: zoneForCursor(x, y, pane, centerAllowed) };
			}
		}
		return null;
	};

	const onDragOver = (e: DragEvent) => {
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		const next = hitTest(e);
		setHover((prev) =>
			prev?.tabId === next?.tabId && prev?.zone === next?.zone ? prev : next
		);
	};

	const onDrop = (e: DragEvent) => {
		e.preventDefault();
		const target = hitTest(e);
		setHover(null);
		if (!target) {
			dnd.onEnd();
			return;
		}
		if (target.zone === "center") {
			swapSplitPanes(draggingId, target.tabId);
		} else {
			splitPane(draggingId, target.tabId, target.zone);
		}
		dnd.onEnd();
	};

	// The preview rect, positioned in px against the live container box.
	let previewStyle: CSSProperties | null = null;
	if (hover) {
		const rects = pxRects();
		const pane = rects?.get(hover.tabId);
		if (pane) {
			const r = previewRect(pane, hover.zone);
			previewStyle = {
				left: r.left,
				top: Math.max(r.top, TITLEBAR_PX),
				width: r.width,
				height: r.height - Math.max(0, TITLEBAR_PX - r.top),
			};
		}
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: pure drag-and-drop catcher, keyboard flows use the tab context menus
		<div
			aria-hidden
			className="absolute inset-x-0 bottom-0 z-30"
			onDragLeave={() => setHover(null)}
			onDragOver={onDragOver}
			onDrop={onDrop}
			style={{ top: TITLEBAR_PX }}
		>
			{previewStyle && (
				<div
					className={cn(
						"pointer-events-none absolute rounded-lg bg-primary/15 ring-2 ring-primary/50 ring-inset transition-all duration-150 ease-out",
						hover?.zone === "center" && "bg-primary/10 ring-primary/40"
					)}
					// The overlay's own origin already sits at TITLEBAR_PX, so pull the
					// container-relative preview coords back up by that offset.
					style={{
						...previewStyle,
						top: (previewStyle.top as number) - TITLEBAR_PX,
					}}
				>
					{hover?.zone === "center" && (
						<span className="absolute inset-0 flex items-center justify-center font-medium text-primary/80 text-xs">
							Swap panes
						</span>
					)}
				</div>
			)}
		</div>
	);
}
