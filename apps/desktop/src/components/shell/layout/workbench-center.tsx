import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type ComponentProps,
	lazy,
	type ReactNode,
	type RefObject,
	Suspense,
} from "react";
import { EmptyTabsState } from "@/src/components/layout/EmptyTabsState.tsx";
import { ScrollableTabsView } from "@/src/components/layout/ScrollableTabsView.tsx";
import type { Tab } from "@/src/contexts/TabsContext.tsx";
import {
	CurrentTabIdProvider,
	type findSplit,
	IsActiveTabProvider,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import { RouteOutlet } from "@/src/contributions/RouteOutlet.tsx";
import type { DesktopWorkbenchValue } from "@/src/workbench/DesktopWorkbenchContext.tsx";
import { RouteWorkbenchItem } from "@/src/workbench/RouteWorkbenchItem.tsx";
import { ShellWorkbenchItem } from "@/src/workbench/ShellWorkbenchItem.tsx";

// The canvas tab view (React Flow) loads only when a user picks it.
const InfiniteTabsCanvas = lazy(() =>
	import("@/src/components/layout/InfiniteTabsCanvas.tsx").then((module) => ({
		default: module.InfiniteTabsCanvas,
	}))
);

import { useWorkbenchDockBridgeValue } from "@/src/workbench/useWorkbenchTools.tsx";
import { WorkbenchDockRequests } from "@/src/workbench/WorkbenchDockRequests.tsx";
import { WorkbenchItemHost } from "@/src/workbench/WorkbenchItemHost.tsx";
import { renderWorkbenchItemIcon } from "@/src/workbench/WorkbenchItemIcon.tsx";
import { CompatibilityWorkbenchFrame } from "@/src/workbench/WorkbenchLayout.tsx";
import { useWorkbenchToolsContext } from "@/src/workbench/workbench-chrome.tsx";
import {
	useMarkWorkbenchDocksActive,
	WorkbenchDockBridgeProvider,
} from "@/src/workbench/workbench-dock-bridge.tsx";
import { SidebarPanelContent } from "../../layout/AppSidebar.tsx";
import { SplitDropZones } from "../../layout/SplitDropZones.tsx";
import splitStyles from "../../layout/SplitView.module.css";
import type { PaneCssVariables } from "../../layout/SplitView.tsx";
import {
	type computeSplitLayout,
	paneNeedsTopClearance,
	paneRectStyle,
	SplitGutters,
} from "../../layout/SplitView.tsx";
import { TitleBar } from "../../layout/TitleBar.tsx";
import { TitlebarPage } from "../../layout/TitlebarPage.tsx";
import { useTabDnd } from "../../layout/tabDnd.tsx";
import type { LayoutCssVariables } from "./layout-constants.ts";
import { PaneBadge } from "./pane-badge.tsx";

/** Joins the workbench strips to the shell's one tab drag session. Lives
    inside TabDndProvider, which LayoutContent itself renders. */
export function DraggableWorkbenchFrame(
	props: Omit<
		ComponentProps<typeof CompatibilityWorkbenchFrame>,
		"addMenu" | "drag" | "prepareItemForSplit"
	>
) {
	const dnd = useTabDnd();
	const { prepareTabForWorkbenchSplit } = useTabsContext();
	const workbenchTools = useWorkbenchToolsContext();
	const dockBridge = useWorkbenchDockBridgeValue();
	useMarkWorkbenchDocksActive();
	const frame = (
		<CompatibilityWorkbenchFrame
			{...props}
			addMenu={
				workbenchTools
					? {
							openTool: (toolId, groupId) =>
								workbenchTools.openTool(toolId, { groupId }),
							tools: workbenchTools.tools,
						}
					: undefined
			}
			drag={{
				draggingId: dnd.draggingId,
				end: dnd.onEnd,
				start: dnd.onStart,
			}}
			prepareItemForSplit={prepareTabForWorkbenchSplit}
			renderItemIcon={renderWorkbenchItemIcon}
		/>
	);
	// While the frame is up, chats open their panels as workbench tabs and the
	// shell serves page/terminal/app panel requests here.
	return dockBridge ? (
		<WorkbenchDockBridgeProvider value={dockBridge}>
			<WorkbenchDockRequests openPanel={dockBridge.openPanel} />
			{frame}
		</WorkbenchDockBridgeProvider>
	) : (
		frame
	);
}

export interface AlternateTabPanesProps {
	activeSplit: ReturnType<typeof findSplit> | null;
	activeTabId: string;
	closeTab: (id: string) => void;
	contentRef: RefObject<HTMLDivElement | null>;
	cssVariables6: LayoutCssVariables;
	focusTab: (id: string) => void;
	isMobile: boolean;
	splitLayout: ReturnType<typeof computeSplitLayout> | null;
	tabLayout: string;
	tabs: Tab[];
	titleBarActions: ReactNode;
	titleBarClearsContent: boolean;
}

/**
 * The scroll / canvas tab views, and the legacy per-tab panes with their
 * split gutters and drop zones. Only rendered when an alternate tab view owns
 * the center surface, so `alternateTabView` is always true in here.
 */
export function AlternateTabPanes({
	activeSplit,
	activeTabId,
	closeTab,
	contentRef,
	cssVariables6,
	focusTab,
	isMobile,
	splitLayout,
	tabLayout,
	tabs,
	titleBarActions,
	titleBarClearsContent,
}: AlternateTabPanesProps) {
	const alternateTabView = true;
	return (
		<div
			className={cn("relative min-h-0 flex-1 overflow-hidden")}
			ref={contentRef}
			style={cssVariables6}
		>
			{tabs.length === 0 ? (
				<EmptyTabsState />
			) : tabLayout === "scroll" ? (
				<ScrollableTabsView />
			) : tabLayout === "canvas" ? (
				<Suspense fallback={null}>
					<InfiniteTabsCanvas />
				</Suspense>
			) : (
				tabs.map((tab) => {
					// `focused` drives the titlebar and the active-pane highlight; a
					// split also shows non-focused panes, which stay fully live.
					const focused = tab.id === activeTabId;
					const paneRect = splitLayout?.panes.get(tab.id);
					const visible = paneRect
						? true
						: !activeSplit && tab.id === activeTabId;
					// Panes are absolutely positioned so the tree is never reparented
					// (reparenting would unmount it and lose state). Hidden-but-mounted
					// tabs keep their timers/subscriptions; unloaded tabs are dropped
					// entirely. Active split members are exempt from unloading, so a
					// visible pane is never null.
					const geometry = paneRect ? paneRectStyle(paneRect) : undefined;
					const paneVariables: PaneCssVariables = {
						"--pane-left": geometry?.left?.toString(),
						"--pane-top": geometry?.top?.toString(),
						"--pane-width": geometry?.width?.toString(),
						"--pane-height": geometry?.height?.toString(),
					};

					const titlebarInset =
						titleBarClearsContent &&
						(paneRect ? paneNeedsTopClearance(paneRect) : true)
							? 80
							: 0;
					return (
						<IsActiveTabProvider
							isActive={focused}
							key={`${tab.id}:${tab.navToken ?? 0}`}
						>
							<CurrentTabIdProvider tabId={tab.id}>
								{tab.unloaded ? null : (
									<div
										className={cn(
											"group/pane flex flex-col overflow-hidden",
											paneRect
												? splitStyles.pane
												: visible
													? "absolute inset-0"
													: "hidden"
										)}
										// Clicking anywhere in a non-focused pane focuses it
										// (no nav-history entry) before the inner UI reacts.
										onMouseDownCapture={
											activeSplit && visible && !focused
												? () => focusTab(tab.id)
												: undefined
										}
										style={paneVariables}
									>
										<TitlebarPage
											inset={titlebarInset}
											selfInset={
												tab.path === "/chat" || tab.path.startsWith("/chat/")
											}
										>
											<RouteOutlet onClose={() => closeTab(tab.id)} tab={tab} />
										</TitlebarPage>
										<PaneBadge
											actions={focused ? titleBarActions : undefined}
											activeSplit={!!activeSplit && visible}
											focused={focused}
											tab={tab}
										/>
									</div>
								)}
							</CurrentTabIdProvider>
						</IsActiveTabProvider>
					);
				})
			)}
			{activeSplit && (
				<SplitGutters containerRef={contentRef} split={activeSplit} />
			)}
			{/* Warp-style drop zones: while a tab chip/row is dragged, hovering
		    a pane edge previews + creates a split there; the center swaps
		    panes. Renders nothing outside a drag. */}
			{!(isMobile || alternateTabView) && <SplitDropZones />}
		</div>
	);
}

/** The default center surface: the draggable workbench frame and its items. */
export function WorkbenchCenter({
	centerHasRouteItems,
	closeTab,
	dispatchWorkbench,
	isMobile,
	navClusterReserve,
	navigationMoved,
	pageActionsMargin,
	panelProps,
}: {
	centerHasRouteItems: boolean;
	closeTab: (id: string) => void;
	dispatchWorkbench: DesktopWorkbenchValue["dispatch"];
	isMobile: boolean;
	navClusterReserve: string;
	navigationMoved: boolean;
	pageActionsMargin: string;
	panelProps: ComponentProps<typeof SidebarPanelContent>;
}) {
	return (
		<DraggableWorkbenchFrame
			centerContent={centerHasRouteItems ? null : <EmptyTabsState />}
			centerGlobalOverlay={isMobile ? null : <SplitDropZones />}
			centerOverlay={
				<TitleBar
					navClusterReserve={navClusterReserve}
					pageActionsMargin={pageActionsMargin}
				/>
			}
			itemHost={
				<WorkbenchItemHost
					renderItem={(item) =>
						item.source.kind === "route" ? (
							<RouteWorkbenchItem item={item} />
						) : item.source.kind === "navigation" ? (
							navigationMoved ? (
								<div
									className="ryu-sidebar-surface flex h-full min-h-0 w-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground"
									data-sidebar-preview-boundary=""
								>
									<SidebarPanelContent {...panelProps} />
								</div>
							) : null
						) : (
							<ShellWorkbenchItem item={item} />
						)
					}
				/>
			}
			onCloseItem={(item) => {
				if (item.source.kind === "route") {
					closeTab(item.id);
				} else {
					dispatchWorkbench({ type: "item/close", itemId: item.id });
				}
			}}
		/>
	);
}
