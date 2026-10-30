import { cn } from "@ryu/ui/lib/utils.ts";
import type { WorkbenchRegion } from "@ryu/workbench/model";
import { type CSSProperties, type DragEvent, useState } from "react";
import { useDesktopWorkbench } from "./DesktopWorkbenchContext.tsx";
import { REGION_LABELS } from "./WorkbenchTabStrip.tsx";
import { useWorkbenchChrome } from "./workbench-chrome.tsx";

/**
 * While a tab is dragged, covers a Left/Right/Bottom group's body so a drop
 * anywhere on it appends the tab to that group. Page content (including
 * frames, which swallow drag events) never has to cooperate. Renders nothing
 * outside a drag, and never covers the strip the drag started from.
 */
export function WorkbenchGroupDropTarget({ groupId }: { groupId: string }) {
	const { moveItem, state } = useDesktopWorkbench();
	const { drag } = useWorkbenchChrome();
	const [hovered, setHovered] = useState(false);
	const draggingId = drag?.draggingId ?? null;
	const group = state.groups.find((candidate) => candidate.id === groupId);
	if (!(draggingId && group)) {
		return null;
	}
	const onDragOver = (event: DragEvent) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		setHovered(true);
	};
	const onDrop = (event: DragEvent) => {
		event.preventDefault();
		setHovered(false);
		moveItem(draggingId, { groupId });
		drag?.end();
	};
	return (
		<div
			aria-hidden
			className={cn(
				"absolute inset-0 z-30 rounded-xl transition-colors motion-reduce:transition-none",
				hovered && "border border-primary border-dashed bg-primary/5"
			)}
			data-workbench-drop-target={group.region}
			onDragLeave={() => setHovered(false)}
			onDragOver={onDragOver}
			onDrop={onDrop}
		/>
	);
}

type EdgeRegion = Extract<WorkbenchRegion, "bottom" | "right">;

const EDGE_STYLES: Record<EdgeRegion, CSSProperties> = {
	bottom: { bottom: 24, height: 56, left: 0, right: 0 },
	right: { bottom: 24, right: 0, top: 48, width: 56 },
};

/**
 * Drop targets for Right and Bottom when they are not on screen (hidden or
 * empty), so a tab can be dragged into any region, not only visible ones.
 */
export function WorkbenchEdgeDropTargets({
	visible,
}: {
	visible: Record<EdgeRegion, boolean>;
}) {
	const { moveItem } = useDesktopWorkbench();
	const { drag, movableRegions } = useWorkbenchChrome();
	const [hovered, setHovered] = useState<EdgeRegion | null>(null);
	const draggingId = drag?.draggingId ?? null;
	if (!draggingId) {
		return null;
	}
	const regions = (["right", "bottom"] as const).filter(
		(region) => !visible[region] && movableRegions.includes(region)
	);
	return regions.map((region) => (
		<div
			aria-hidden
			className={cn(
				"absolute z-40 flex items-center justify-center rounded-xl border border-primary border-dashed bg-background text-primary text-xs transition-colors motion-reduce:transition-none",
				hovered === region && "bg-primary/5"
			)}
			data-workbench-edge-drop={region}
			key={region}
			onDragLeave={() => setHovered(null)}
			onDragOver={(event) => {
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				setHovered(region);
			}}
			onDrop={(event) => {
				event.preventDefault();
				setHovered(null);
				moveItem(draggingId, { region });
				drag?.end();
			}}
			style={EDGE_STYLES[region]}
		>
			{REGION_LABELS[region]}
		</div>
	));
}
