import { Add01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type {
	WorkbenchGroup,
	WorkbenchItem,
	WorkbenchRegion as WorkbenchRegionName,
} from "@ryu/workbench/model";
import { type CSSProperties, type ReactNode, useCallback, useRef } from "react";
import { useDesktopWorkbench } from "./DesktopWorkbenchContext.tsx";
import { WorkbenchGroupDropTarget } from "./WorkbenchDropTargets.tsx";
import styles from "./WorkbenchRegion.module.css";
import { REGION_LABELS, WorkbenchTabStrip } from "./WorkbenchTabStrip.tsx";
import { useWorkbenchSlots } from "./workbench-slots.tsx";

interface WorkbenchRegionProps {
	className?: string;
	compatibilityContent?: ReactNode;
	groups: WorkbenchGroup[];
	onCloseItem?: (item: WorkbenchItem) => void;
	overlay?: ReactNode;
	region: WorkbenchRegionName;
	style?: CSSProperties;
	suppressTabStrips?: boolean;
}

function WorkbenchItemSlot({
	children,
	groupId,
	itemId,
}: {
	children?: ReactNode;
	groupId: string;
	itemId: string;
}) {
	const { registerSlot, unregisterSlot } = useWorkbenchSlots();
	const elementRef = useRef<HTMLDivElement | null>(null);
	const setSlotRef = useCallback(
		(element: HTMLDivElement | null) => {
			const previous = elementRef.current;
			if (previous) {
				unregisterSlot(groupId, itemId, previous);
			}
			elementRef.current = element;
			if (element) {
				registerSlot(groupId, itemId, element);
			}
		},
		[groupId, itemId, registerSlot, unregisterSlot]
	);

	return (
		<div
			className="relative min-h-0 flex-1 overflow-hidden"
			data-workbench-item={itemId}
			data-workbench-slot={`${groupId}:${itemId}`}
			ref={setSlotRef}
		>
			{children}
		</div>
	);
}

/**
 * An empty Center group: offers a new view, and — when another Center group
 * exists — closes the pane so an emptied split never strands blank space.
 */
export function EmptyCenterGroup({ group }: { group: WorkbenchGroup }) {
	const { dispatch, state } = useDesktopWorkbench();
	const canClosePane =
		group.region === "center" &&
		state.groups.filter((candidate) => candidate.region === "center").length >
			1;
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 bg-background">
			<Button
				onClick={() =>
					window.dispatchEvent(
						new CustomEvent("ryu:workbench-add", {
							detail: { groupId: group.id, region: group.region },
						})
					)
				}
				size="sm"
				variant="ghost-muted"
			>
				<HugeiconsIcon icon={Add01Icon} />
				Add a view
			</Button>
			{canClosePane ? (
				<Button
					onClick={() =>
						dispatch({ type: "center/remove-group", groupId: group.id })
					}
					size="sm"
					variant="ghost-muted"
				>
					<HugeiconsIcon icon={Cancel01Icon} />
					Close pane
				</Button>
			) : null}
		</div>
	);
}

function WorkbenchGroupView({
	compatibilityContent,
	focused,
	group,
	items,
	onCloseItem,
	showTabStrip,
}: {
	compatibilityContent?: ReactNode;
	focused: boolean;
	group: WorkbenchGroup;
	items: WorkbenchItem[];
	onCloseItem?: (item: WorkbenchItem) => void;
	showTabStrip: boolean;
}) {
	const { dispatch } = useDesktopWorkbench();
	const activeItem = items.find((item) => item.id === group.activeItemId);

	return (
		<div
			className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
			data-focused={focused}
			data-group-id={group.id}
			onMouseDownCapture={() =>
				dispatch({ type: "group/focus", groupId: group.id })
			}
		>
			{showTabStrip ? (
				<WorkbenchTabStrip
					focused={focused}
					group={group}
					items={items}
					onCloseItem={onCloseItem}
				/>
			) : null}
			<div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
				{activeItem ? (
					<WorkbenchItemSlot groupId={group.id} itemId={activeItem.id}>
						{compatibilityContent}
					</WorkbenchItemSlot>
				) : compatibilityContent ? (
					<div className="relative min-h-0 flex-1 overflow-hidden">
						{compatibilityContent}
					</div>
				) : (
					<EmptyCenterGroup group={group} />
				)}
				{group.region === "center" ? null : (
					<WorkbenchGroupDropTarget groupId={group.id} />
				)}
			</div>
		</div>
	);
}

export function WorkbenchRegion({
	className,
	compatibilityContent,
	groups,
	onCloseItem,
	overlay,
	region,
	style,
	suppressTabStrips = false,
}: WorkbenchRegionProps) {
	const { state } = useDesktopWorkbench();
	const visibleGroups = groups.filter(
		(group) => region === "center" || group.itemIds.length > 0
	);
	if (visibleGroups.length === 0) {
		return null;
	}

	const label = REGION_LABELS[region];
	const groupStyle: CSSProperties & { "--workbench-group-count": number } = {
		"--workbench-group-count": visibleGroups.length,
	};
	return (
		<section
			aria-label={label}
			className={cn(
				"relative min-h-0 min-w-0 overflow-hidden border-border bg-background",
				region === "left" && "border-r",
				region === "right" && "border-l",
				region === "bottom" && "border-t",
				className
			)}
			data-focused={visibleGroups.some(
				(group) => group.id === state.focusedGroupId
			)}
			data-region={region}
			style={style}
		>
			<div
				className={cn(
					"grid h-full min-h-0 min-w-0",
					styles.groups,
					visibleGroups.length > 1 && "divide-x divide-border"
				)}
				style={groupStyle}
			>
				{visibleGroups.map((group, index) => {
					const items = group.itemIds.flatMap((itemId) => {
						const item = state.items.find(
							(candidate) => candidate.id === itemId
						);
						return item ? [item] : [];
					});
					return (
						<WorkbenchGroupView
							compatibilityContent={
								region === "center" && index === 0
									? compatibilityContent
									: undefined
							}
							focused={group.id === state.focusedGroupId}
							group={group}
							items={items}
							key={group.id}
							onCloseItem={onCloseItem}
							showTabStrip={!suppressTabStrips}
						/>
					);
				})}
			</div>
			{overlay ? (
				<div
					className="pointer-events-none absolute inset-0 z-30 [&>*]:pointer-events-auto"
					data-workbench-center-overlay=""
				>
					{overlay}
				</div>
			) : null}
		</section>
	);
}
