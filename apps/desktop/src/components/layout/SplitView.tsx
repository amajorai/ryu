import { cn } from "@ryu/ui/lib/utils.ts";
import type { WorkbenchGroup, WorkbenchItem } from "@ryu/workbench/model";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useMemo, useRef } from "react";
import { useDesktopWorkbench } from "@/src/workbench/DesktopWorkbenchContext.tsx";
import { EmptyCenterGroup } from "@/src/workbench/WorkbenchRegion.tsx";
import { WorkbenchTabStrip } from "@/src/workbench/WorkbenchTabStrip.tsx";
import { useWorkbenchSlots } from "@/src/workbench/workbench-slots.tsx";
import splitStyles from "./SplitView.module.css";
import { WorkbenchCenterGutters } from "./split-view-gutters.tsx";
import {
	axisCalc,
	computeCenterGroupLayout,
	type PaneCssVariables,
} from "./split-view-layout.ts";

// Pane layout math and the gutters live in `split-view-layout.ts` and
// `split-view-gutters.tsx`; this module keeps the public import path.
export { SplitGutters } from "./split-view-gutters.tsx";
export {
	type AxisCoeff,
	computeCenterGroupLayout,
	computeSplitLayout,
	FULL_PANE_RECT,
	type GutterSpec,
	type PaneCssVariables,
	type PaneRect,
	paneNeedsTopClearance,
	paneRectPx,
	paneRectStyle,
	SPLIT_GUTTER_PX,
	type SplitLayout,
} from "./split-view-layout.ts";

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
			className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
			data-workbench-item={itemId}
			data-workbench-slot={`${groupId}:${itemId}`}
			ref={setSlotRef}
		>
			{children}
		</div>
	);
}

function CenterGroupView({
	compatibilityContent,
	focused,
	group,
	hideTabStrip,
	items,
	onCloseItem,
	overlay,
	showOverlay,
	style,
}: {
	compatibilityContent?: ReactNode;
	focused: boolean;
	group: WorkbenchGroup;
	hideTabStrip: boolean;
	items: WorkbenchItem[];
	onCloseItem?: (item: WorkbenchItem) => void;
	overlay?: ReactNode;
	showOverlay: boolean;
	style: CSSProperties;
}) {
	const { dispatch } = useDesktopWorkbench();
	const activeItem = items.find((item) => item.id === group.activeItemId);
	return (
		<div
			className={cn(
				"absolute flex min-h-0 min-w-0 flex-col overflow-hidden bg-background",
				splitStyles.pane
			)}
			data-focused={focused}
			data-group-id={group.id}
			onMouseDownCapture={() =>
				dispatch({ type: "group/focus", groupId: group.id })
			}
			style={style}
		>
			{hideTabStrip ? null : (
				<WorkbenchTabStrip
					focused={focused}
					group={group}
					items={items}
					onCloseItem={onCloseItem}
				/>
			)}
			{activeItem ? (
				<WorkbenchItemSlot groupId={group.id} itemId={activeItem.id}>
					{compatibilityContent}
				</WorkbenchItemSlot>
			) : compatibilityContent ? (
				<div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
					{compatibilityContent}
				</div>
			) : (
				<EmptyCenterGroup group={group} />
			)}
			{showOverlay && overlay ? (
				<div
					className="pointer-events-none absolute inset-0 z-30 [&>*]:pointer-events-auto"
					data-workbench-center-overlay=""
				>
					{overlay}
				</div>
			) : null}
		</div>
	);
}

export function DesktopCenterSplitView({
	collapseToFocused = false,
	compatibilityContent,
	globalOverlay,
	onCloseItem,
	overlay,
	style,
	suppressFocusedTabStrip = false,
}: {
	/** Narrow windows show only the focused Center pane; the tree is kept. */
	collapseToFocused?: boolean;
	compatibilityContent?: ReactNode;
	globalOverlay?: ReactNode;
	onCloseItem?: (item: WorkbenchItem) => void;
	overlay?: ReactNode;
	style?: CSSProperties;
	suppressFocusedTabStrip?: boolean;
}) {
	const { state } = useDesktopWorkbench();
	const containerRef = useRef<HTMLElement | null>(null);
	const centerGroups = state.groups.filter(
		(group) => group.region === "center"
	);
	const collapsedGroupId =
		collapseToFocused && state.centerTree.type === "branch"
			? (centerGroups.find((group) => group.id === state.focusedGroupId)?.id ??
				centerGroups.find((group) => group.activeItemId !== null)?.id ??
				centerGroups[0]?.id)
			: undefined;
	const layout = useMemo(
		() =>
			computeCenterGroupLayout(
				collapsedGroupId
					? { type: "leaf", groupId: collapsedGroupId }
					: state.centerTree
			),
		[collapsedGroupId, state.centerTree]
	);
	const firstGroupId = layout.panes.keys().next().value;
	const focusedCenterGroupId = centerGroups.some(
		(group) => group.id === state.focusedGroupId && group.activeItemId !== null
	)
		? state.focusedGroupId
		: undefined;
	const overlayGroupId =
		focusedCenterGroupId ??
		centerGroups.find((group) => group.activeItemId !== null)?.id ??
		firstGroupId;
	return (
		<section
			aria-label="Center"
			className="relative min-h-0 min-w-0 overflow-hidden bg-background"
			data-focused={centerGroups.some(
				(group) => group.id === state.focusedGroupId
			)}
			data-region="center"
			ref={containerRef}
			style={style}
		>
			{centerGroups.flatMap((group) => {
				const rect = layout.panes.get(group.id);
				if (!rect) {
					return [];
				}
				const items = group.itemIds.flatMap((itemId) => {
					const item = state.items.find((candidate) => candidate.id === itemId);
					return item ? [item] : [];
				});
				const paneVariables: PaneCssVariables = {
					"--pane-left": axisCalc(rect.left),
					"--pane-top": axisCalc(rect.top),
					"--pane-width": axisCalc(rect.width),
					"--pane-height": axisCalc(rect.height),
				};
				const focused = group.id === state.focusedGroupId;
				const showOverlay = group.id === overlayGroupId;
				return [
					<CenterGroupView
						compatibilityContent={
							group.id === firstGroupId ? compatibilityContent : undefined
						}
						focused={focused}
						group={group}
						hideTabStrip={showOverlay && (suppressFocusedTabStrip || !!overlay)}
						items={items}
						key={group.id}
						onCloseItem={onCloseItem}
						overlay={showOverlay ? overlay : undefined}
						showOverlay={showOverlay}
						style={paneVariables}
					/>,
				];
			})}
			<WorkbenchCenterGutters containerRef={containerRef} layout={layout} />
			{globalOverlay}
		</section>
	);
}
