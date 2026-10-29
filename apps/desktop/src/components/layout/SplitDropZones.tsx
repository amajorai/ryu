import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties, DragEvent } from "react";
import { useRef, useState } from "react";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import type { SplitDirection } from "@/src/lib/splitTree.ts";
import { useDesktopWorkbench } from "@/src/workbench/DesktopWorkbenchContext.tsx";
import { applyWorkbenchPaneDrop } from "@/src/workbench/workbench-drop.ts";
import layoutStyles from "./SplitDropZones.module.css";
import {
	computeCenterGroupLayout,
	type PaneRect,
	paneRectPx,
} from "./SplitView.tsx";
import { useTabDnd } from "./tabDnd.tsx";

// Kept as a re-export for callers and tests that import it from here.
export { applyWorkbenchPaneDrop } from "@/src/workbench/workbench-drop.ts";

const TITLEBAR_PX = 48;
const CENTER_BAND = 0.5;
const OVERLAY_STYLE: CSSProperties & { "--tab-drop-top": string } = {
	"--tab-drop-top": `${TITLEBAR_PX}px`,
};

interface HoverZone {
	groupId: string;
	zone: SplitDirection | "center";
}

interface PxRect {
	height: number;
	left: number;
	top: number;
	width: number;
}

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
	const normalizedX = (x - pane.left) / Math.max(1, pane.width);
	const normalizedY = (y - pane.top) / Math.max(1, pane.height);
	const margin = (1 - CENTER_BAND) / 2;
	const inCenter =
		normalizedX > margin &&
		normalizedX < 1 - margin &&
		normalizedY > margin &&
		normalizedY < 1 - margin;
	if (inCenter && centerAllowed) {
		return "center";
	}
	const distances: [SplitDirection, number][] = [
		["left", normalizedX],
		["right", 1 - normalizedX],
		["up", normalizedY],
		["down", 1 - normalizedY],
	];
	distances.sort((first, second) => first[1] - second[1]);
	return distances[0][0];
}

/** Drop targets are Center group leaves. Edge drops split the target group and
 * move the dragged item; center drops exchange the active items of two Center
 * groups, or move a tab from Left/Right/Bottom into the hovered group. */
export function SplitDropZones() {
	const dnd = useTabDnd();
	const { dispatch, state } = useDesktopWorkbench();
	const { prepareTabForWorkbenchSplit } = useTabsContext();
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const [hover, setHover] = useState<HoverZone | null>(null);
	const draggingId = dnd.draggingId;
	if (!draggingId) {
		return null;
	}

	const layout = computeCenterGroupLayout(state.centerTree);
	const sourceGroup = state.groups.find((group) =>
		group.itemIds.includes(draggingId)
	);
	const paneRects = new Map<string, PaneRect>(layout.panes);
	const pxRects = (): Map<string, PxRect> | null => {
		const element = overlayRef.current?.parentElement;
		if (!element) {
			return null;
		}
		const box = element.getBoundingClientRect();
		const result = new Map<string, PxRect>();
		for (const [groupId, rect] of paneRects) {
			result.set(
				groupId,
				paneRectPx(rect, { width: box.width, height: box.height })
			);
		}
		return result;
	};

	const hitTest = (event: DragEvent): HoverZone | null => {
		const element = overlayRef.current?.parentElement;
		const rects = pxRects();
		if (!(element && rects)) {
			return null;
		}
		const box = element.getBoundingClientRect();
		const x = event.clientX - box.left;
		const y = event.clientY - box.top;
		for (const [groupId, pane] of rects) {
			if (
				x >= pane.left &&
				x <= pane.left + pane.width &&
				y >= pane.top &&
				y <= pane.top + pane.height
			) {
				return {
					groupId,
					zone: zoneForCursor(
						x,
						y,
						pane,
						sourceGroup !== undefined && sourceGroup.id !== groupId
					),
				};
			}
		}
		return null;
	};

	const onDragOver = (event: DragEvent) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		const next = hitTest(event);
		setHover((previous) =>
			previous?.groupId === next?.groupId && previous?.zone === next?.zone
				? previous
				: next
		);
	};

	const onDrop = (event: DragEvent) => {
		event.preventDefault();
		const target = hitTest(event);
		setHover(null);
		if (!target) {
			dnd.onEnd();
			return;
		}
		applyWorkbenchPaneDrop({
			dispatch,
			draggingId,
			state,
			synchronizeRoute: prepareTabForWorkbenchSplit,
			targetGroupId: target.groupId,
			zone: target.zone,
		});
		dnd.onEnd();
	};

	const pane = hover ? pxRects()?.get(hover.groupId) : undefined;
	const preview = pane && hover ? previewRect(pane, hover.zone) : null;
	const previewStyle: PreviewVariables | null = preview
		? {
				"--preview-left": `${preview.left}px`,
				"--preview-top": `${Math.max(preview.top, TITLEBAR_PX) - TITLEBAR_PX}px`,
				"--preview-width": `${preview.width}px`,
				"--preview-height": `${preview.height - Math.max(0, TITLEBAR_PX - preview.top)}px`,
			}
		: null;

	// Keep the pane target below the tab strip. Mounting a hit surface over
	// the pressed source during dragstart makes Chromium cancel its native
	// drag before it can deliver dragover/drop to either target.
	return (
		<div
			aria-hidden
			className="absolute inset-x-0 top-(--tab-drop-top) bottom-0 z-30"
			data-tab-drop-overlay
			onDragLeave={() => setHover(null)}
			onDragOver={onDragOver}
			onDrop={onDrop}
			ref={overlayRef}
			style={OVERLAY_STYLE}
		>
			{previewStyle ? (
				<div
					className={cn(
						layoutStyles.preview,
						cn(
							"pointer-events-none absolute rounded-lg bg-primary/15 ring-2 ring-primary/50 ring-inset duration-200 motion-reduce:transition-none",
							layoutStyles.authored1,
							layoutStyles.authored2
						),
						hover?.zone === "center" && "bg-primary/10 ring-primary/40"
					)}
					data-drop-preview={hover?.zone}
					style={previewStyle}
				>
					{hover?.zone === "center" ? (
						<span className="absolute inset-0 flex items-center justify-center font-medium text-primary/80 text-xs">
							{sourceGroup?.region === "center" ? "Swap panes" : "Move here"}
						</span>
					) : null}
				</div>
			) : null}
		</div>
	);
}

interface PreviewVariables extends CSSProperties {
	"--preview-height": string;
	"--preview-left": string;
	"--preview-top": string;
	"--preview-width": string;
}
