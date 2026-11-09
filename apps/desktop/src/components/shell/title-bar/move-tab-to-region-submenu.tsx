import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ContextMenuItem,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { useDirection } from "@ryu/ui/components/direction.tsx";
import { physicalSide } from "@/src/workbench/workbench-direction.ts";

/** The workbench regions a window tab can move into, in menu order. */
export const TAB_MOVE_REGIONS = ["center", "right", "bottom"] as const;

export type TabMoveRegion = (typeof TAB_MOVE_REGIONS)[number];

/** Message sources for the side a region is drawn on, resolved at render. */
const REGION_SIDE_LABELS = {
	bottom: "Bottom",
	center: "Center",
	left: "Left",
	right: "Right",
} as const;

/**
 * "Move to pane" submenu of a window tab. Each entry names the side the region
 * is drawn on (`physicalSide`), so under RTL the stored `right` region, which
 * the grid draws on screen-left, reads "Left"; `onMove` still receives the
 * stored region id.
 */
export function MoveTabToRegionSubmenu({
	onMove,
}: {
	onMove: (region: TabMoveRegion) => void;
}) {
	const tl = useLiteralMessages();
	const dir = useDirection();
	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger>{tl("Move to pane")}</ContextMenuSubTrigger>
			<ContextMenuSubContent>
				{TAB_MOVE_REGIONS.map((region) => (
					<ContextMenuItem key={region} onClick={() => onMove(region)}>
						{tl(REGION_SIDE_LABELS[physicalSide(region, dir)])}
					</ContextMenuItem>
				))}
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
}
