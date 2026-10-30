import { SidebarInset, useSidebar } from "@ryu/ui/components/sidebar.tsx";
import { useIsMobile } from "@ryu/ui/hooks/use-mobile.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type ComponentProps, lazy, Suspense, useRef } from "react";
import { AutoUpdater } from "@/src/components/updater/AutoUpdater.tsx";
import {
	useAppSurface,
	useHostBackButtonSync,
} from "@/src/contexts/app-surface-context.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { findSplit, useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useTitleBarContext } from "@/src/contexts/TitleBarContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { useAssistantPageReset } from "@/src/hooks/useAssistantPageReset.ts";
import { useConsoleAccess } from "@/src/hooks/useConsoleAccess.ts";
import { useFolderProjectMigration } from "@/src/hooks/useFolderProjectMigration.ts";
import { useOpenConversationEvents } from "@/src/hooks/useOpenConversationEvents.ts";
import { useSidebarVariant } from "@/src/hooks/useSidebarVariant.ts";
import { useTabLayout } from "@/src/hooks/useTabLayout.ts";
import { useTitleBarClearsContent } from "@/src/hooks/useTitleBarClearsContent.ts";
import { useActiveInterface } from "@/src/interfaces/interface-store.ts";
import { useSyncContributedInterfaces } from "@/src/interfaces/use-contributed-interfaces.ts";
import { useProductMode, useProductModeStore } from "@/src/lib/product-mode.ts";
import { isDetachedTabWindow } from "@/src/lib/tab-transfer.ts";
import { windowChromeLayout } from "@/src/lib/window-chrome-layout.ts";
import { useAssistantStore } from "@/src/store/useAssistantStore.ts";
import { useDesktopWorkbench } from "@/src/workbench/DesktopWorkbenchContext.tsx";
import { useWorkbenchDockBridgeValue } from "@/src/workbench/useWorkbenchTools.tsx";
import { workbenchCenterHasRouteItems } from "@/src/workbench/WorkbenchLayout.tsx";
import {
	AppSidebar,
	type SidebarPanelContent,
} from "../../layout/AppSidebar.tsx";
import layoutStyles from "../../layout/Layout.module.css";
import { computeSplitLayout } from "../../layout/SplitView.tsx";
import { TitleBar } from "../../layout/TitleBar.tsx";
import { TabDndProvider } from "../../layout/tabDnd.tsx";
import { WindowNavigationCluster } from "../../layout/WindowNavigationCluster.tsx";
import { isMac } from "./layout-constants.ts";
import {
	buildOsWindows,
	ConversationOverlays,
	layoutCssVariables,
	ShellBanners,
	ShellOverlays,
} from "./shell-overlays.tsx";
import {
	FloatingSidebarPeek,
	useNavigationPlacement,
	useSidebarFloatPeek,
	useSidebarRailResize,
} from "./sidebar-rail.tsx";
import {
	useConversationHandlers,
	useQuickConversationActions,
} from "./use-conversation-actions.ts";
import {
	useClipsQuickAttach,
	useCrashRouteRecorder,
	useExtensionQuickMessageSeed,
	useLayoutAppSubscriptions,
	useRevealSidebarForVerticalTabs,
	useWorkbenchAddListener,
} from "./use-layout-effects.ts";
import { useLayoutHotkeys } from "./use-layout-hotkeys.ts";
import { AlternateTabPanes, WorkbenchCenter } from "./workbench-center.tsx";

// Alternate product shells (an app-contributed interface, the OS desktop) load
// only when that mode is active; the default console never fetches them.
const InterfaceSurface = lazy(() =>
	import("@/src/interfaces/InterfaceSurface.tsx").then((module) => ({
		default: module.InterfaceSurface,
	}))
);
const OsDesktopSurfaceWithApps = lazy(() =>
	import("../../os/OsDesktopSurface.tsx").then((module) => ({
		default: module.OsDesktopSurfaceWithApps,
	}))
);

export interface LayoutContentProps {
	nativeWindowChrome: boolean;
	onSidebarWidthChange: (w: number) => void;
	sidebarWidth: number;
}

export function LayoutContent({
	nativeWindowChrome,
	sidebarWidth,
	onSidebarWidthChange,
}: LayoutContentProps) {
	const productMode = useProductMode();
	const botProduct = productMode === "bot";
	const detachedWindow = isDetachedTabWindow();
	const osProduct = productMode === "os" && !detachedWindow;
	// Interfaces: in the workspace tier the user may pick a different
	// presentation (Channels, Feed, a world, or a Marketplace interface) than the
	// OS desktop. Mirror enabled plugins' interfaces for every switcher, then
	// resolve the active one (falls back to OS when a plugin is disabled).
	const contributedInterfaces = useSyncContributedInterfaces();
	const activeInterface = useActiveInterface(contributedInterfaces);
	const interfaceSurface = osProduct && activeInterface.renderer !== "os";
	const activeNode = useActiveNode();
	const { canSwitchToConsole } = useConsoleAccess(activeNode);
	const osAccess = useProductModeStore((state) => state.osAccess);
	const { canUpdateDesktopApp, surface } = useAppSurface();
	const { activeConversationId, conversations, loadMessages } =
		useChatHistoryContext();

	const reconnectRetryState = useLayoutAppSubscriptions();

	const { open, openMobile, setOpen, toggleSidebar } = useSidebar();
	// The desktop app is also served as a web app, so it has to survive phone
	// widths. `isMobile` (<768px) is the single layout-mode switch: the sidebar
	// stops being dockable and becomes the primitive's Sheet, and everything
	// that needs a second column beside the content (assistant rail, split
	// panes, hover-peek) stands down. It is a *width* test, not a Tauri test —
	// native window chrome (traffic lights, drag regions) still keys off
	// `isMac`. The two never collide because the Tauri window's minWidth is
	// 800px, so `isMobile` only ever fires in a browser.
	const isMobile = useIsMobile();
	// On mobile the sidebar is a Sheet, so its open state is `openMobile`.
	const sidebarShown = isMobile ? openMobile : open;
	// Reserve room on the right when the "Ask Ryu" assistant is docked as a
	// sidebar, so the page content slides in beside it rather than under it.
	const assistantMode = useAssistantStore((s) => s.mode);
	const [sidebarVariant] = useSidebarVariant();
	// Floating dock is inset 8px from the right edge (380 + 8); inset mode is a
	// flush rail so only the panel width is reserved.
	const assistantDockReserve =
		assistantMode === "sidebar" && !isMobile
			? sidebarVariant === "floating"
				? 388
				: 380
			: undefined;
	const {
		focusTab,
		splits,
		tabs,
		activeTabId,
		openTab,
		closeTab,
		goBack,
		goForward,
		canGoBack,
		canGoForward,
	} = useTabsContext();
	useAssistantPageReset(activeTabId);
	useExtensionQuickMessageSeed(openTab, surface);
	useHostBackButtonSync(canGoBack, goBack);
	// Session cards in a main thread open their session through this.
	useOpenConversationEvents(openTab);
	// Folder projects move onto the node's Projects app, threads included.
	useFolderProjectMigration();
	const { apps } = useApps();
	const quick = useQuickConversationActions(conversations, activeNode, openTab);
	const { handleOpenQuickPreview, handleOpenQuickReply } = quick;

	useClipsQuickAttach({ activeNode, activeTabId, apps, openTab, tabs });
	const { actions: titleBarActions } = useTitleBarContext();
	const { dispatch: dispatchWorkbench, state: workbenchState } =
		useDesktopWorkbench();
	const { navigationMoved, navigationShown, toggleNavigation } =
		useNavigationPlacement({
			dispatchWorkbench,
			isMobile,
			open,
			osProduct,
			setOpen,
			sidebarShown,
			toggleSidebar,
			workbenchState,
		});
	const workbenchDockBridge = useWorkbenchDockBridgeValue();
	const toggleWorkbenchRegion = (region: "bottom" | "right") => {
		// Only the workbench frame shows these panes (not the scroll/canvas
		// layouts or the OS canvas).
		if (!(osProduct || alternateTabView)) {
			workbenchDockBridge?.toggleRegion(region);
		}
	};
	useWorkbenchAddListener(workbenchState, dispatchWorkbench, openTab);
	const centerHasRouteItems = workbenchCenterHasRouteItems(workbenchState);
	const contentRef = useRef<HTMLDivElement>(null);
	const tabLayout = useTabLayout();
	// Auto-hide frees the top clearance so content fills the window; the bar
	// overlays on hover. Mobile never auto-hides (see TitleBar). Fullscreen forces
	// the same treatment without touching the saved pref. Shared hook keeps this
	// in lockstep with `effectiveAutoHide` in TitleBar — or the bar slides away
	// while the row it occupied stays reserved (a blank strip on screen).
	const titleBarClearsContent = useTitleBarClearsContent();
	const alternateTabView = tabLayout === "scroll" || tabLayout === "canvas";

	useRevealSidebarForVerticalTabs(tabLayout, setOpen);

	// The split (if any) the focused tab belongs to, its computed pane/gutter
	// geometry, and the ids of the panes to show (in the tree's pane order).
	// With no split, only the focused tab is shown — exactly as before. Every
	// other tab stays mounted but hidden so its state survives.
	// Splits need two readable columns side by side, which a phone width has no
	// room for, so the focused tab takes the whole pane area and every split
	// member stays mounted-but-hidden. The split tree itself is untouched —
	// widening the viewport brings the layout straight back.
	const activeSplit =
		isMobile || alternateTabView ? null : findSplit(tabs, splits, activeTabId);
	const splitLayout = activeSplit ? computeSplitLayout(activeSplit.root) : null;
	let paneIds: string[] = workbenchState.groups.flatMap((group) =>
		group.activeItemId ? [group.activeItemId] : []
	);
	if (alternateTabView) {
		paneIds = tabs.map((tab) => tab.id);
	}

	useCrashRouteRecorder(tabs, activeTabId);

	// The floating "Ask Ryu" dock would just overlap a full chat surface, so hide
	// it whenever a `/chat` pane is currently visible (in a split, any visible
	// pane being chat is enough for the overlap). Chat pages already *are* the
	// assistant, so the dock is redundant there.
	const chatPaneVisible = paneIds.some(
		(id) => tabs.find((t) => t.id === id)?.path.startsWith("/chat") ?? false
	);

	// Floating Ryu (Ask Ryu dock) launcher, restored. Hidden only when a chat pane
	// is already visible (that pane IS the assistant, so the dock is redundant
	// there — see `chatPaneVisible` above).
	const showAssistantDock = !(botProduct || osProduct);

	const { handleRailPointerDown, resizingRef } = useSidebarRailResize(
		sidebarWidth,
		onSidebarWidthChange,
		setOpen
	);

	const { floatOpen, scheduleHide, showFloat } = useSidebarFloatPeek(
		open,
		resizingRef
	);

	const {
		handleDeleteConversation,
		handleNewConversation,
		handleSelectConversation,
	} = useConversationHandlers(openTab);
	const sidebarPanelProps: ComponentProps<typeof SidebarPanelContent> = {
		activeConversationId,
		onDeleteConversation: handleDeleteConversation,
		onNewConversation: handleNewConversation,
		onOpenQuickPreview: handleOpenQuickPreview,
		onOpenQuickReply: handleOpenQuickReply,
		onSelectConversation: handleSelectConversation,
	};

	const canSwitchInterface = useLayoutHotkeys({
		botProduct,
		canSwitchToConsole,
		dispatchWorkbench,
		handleNewConversation,
		openTab,
		osAccess,
		toggleNavigation,
		toggleWorkbenchRegion,
		workbenchState,
	});

	// Only a native Desktop window clears OS caption controls. Webapp and the
	// extension may report the same macOS/Windows user agent, but their viewport
	// starts at the browser content edge and must not inherit those gutters.
	const { navClusterPosition, navClusterReserve, pageActionsMargin } =
		windowChromeLayout({
			isMac,
			isMobile,
			nativeWindowChrome,
		});
	// The OS desktop surface consumes this adapter; normal Console renders never
	// do. Avoid allocating one React subtree per retained tab on every shell render
	// when the array cannot reach a consumer.
	// A non-OS interface renders its own thread view, so it skips this adapter.
	const showOsDesktop = osProduct && !interfaceSurface;
	const osWindows = buildOsWindows(showOsDesktop, tabs, activeTabId, closeTab);

	const {
		cssVariables2,
		cssVariables3,
		cssVariables4,
		cssVariables5,
		cssVariables6,
	} = layoutCssVariables({
		assistantDockReserve,
		floatOpen,
		osProduct,
		sidebarWidth,
		titleBarClearsContent,
	});
	const sidebarMounted =
		!(osProduct || navigationMoved) && (!detachedWindow || sidebarShown);
	return (
		<TabDndProvider>
			<ShellOverlays
				botProduct={botProduct}
				canSwitchInterface={canSwitchInterface}
				canSwitchToConsole={canSwitchToConsole}
				detachedWindow={detachedWindow}
				osProduct={osProduct}
				showOsDesktop={showOsDesktop}
			/>
			{sidebarMounted && (
				<AppSidebar
					activeConversationId={activeConversationId}
					onDeleteConversation={handleDeleteConversation}
					onNewConversation={handleNewConversation}
					onOpenQuickPreview={handleOpenQuickPreview}
					onOpenQuickReply={handleOpenQuickReply}
					onSelectConversation={handleSelectConversation}
				/>
			)}

			{/* Pinned navigation cluster (back / forward / sidebar toggle) at the
			    window's top-left. Fixed so it stays put whether the sidebar is docked
			    or collapsed, and out of the tab strip entirely. Native macOS Desktop
			    clears the traffic lights; browser surfaces use their normal viewport
			    inset. At phone widths there is no native chrome to clear and no room
			    for four buttons, so the cluster hugs the top-left corner and drops to
			    the two that cannot be reached any other way: the sidebar (Sheet)
			    toggle and search. Back/forward stay available on the platform's own
			    back gesture and via the hotkeys. */}
			{!osProduct && (
				<WindowNavigationCluster
					canGoBack={canGoBack}
					canGoForward={canGoForward}
					isMac={isMac}
					isMobile={isMobile}
					navClusterPosition={navClusterPosition}
					onGoBack={goBack}
					onGoForward={goForward}
					onSearch={() =>
						window.dispatchEvent(new CustomEvent("ryu:open-command-palette"))
					}
					onToggleSidebar={toggleNavigation}
					showSearch={!botProduct}
					sidebarShown={navigationShown}
				/>
			)}

			{/* Resize handle for the docked sidebar. Pointer-only, and there is no
			    docked sidebar to resize at phone widths. */}
			{open && !(isMobile || osProduct || navigationMoved) && (
				// sidebar resize handle
				<div
					className={cn(
						"fixed top-0 z-20 h-full w-2 cursor-col-resize opacity-0 transition-opacity hover:bg-sidebar-border hover:opacity-100",
						layoutStyles.inline2
					)}
					onPointerDown={handleRailPointerDown}
					// `touch-action: none` is what actually makes this draggable by
					// touch: without it the browser claims the gesture for scrolling
					// before the second pointermove ever reaches us.
					style={cssVariables2}
				/>
			)}

			{/* Left-edge hover zone for floating sidebar. Hover-to-peek has no touch
			    equivalent, and a 288px panel pinned over a 375px viewport would just
			    shadow the Sheet that `<AppSidebar>` already renders at this width —
			    so the whole hand-rolled float stands down on mobile. */}
			{!(
				open ||
				isMobile ||
				detachedWindow ||
				osProduct ||
				navigationMoved
			) && (
				<FloatingSidebarPeek
					cssVariables3={cssVariables3}
					cssVariables4={cssVariables4}
					onRailPointerDown={handleRailPointerDown}
					panelProps={sidebarPanelProps}
					scheduleHide={scheduleHide}
					showFloat={showFloat}
				/>
			)}

			<SidebarInset
				appearance={osProduct ? "os-canvas" : undefined}
				className={cn(
					cn(
						"relative flex flex-col overflow-hidden",
						// Inset is the flush default: the content sits beside the
						// sidebar on tone alone, without the primitive's card margin,
						// radius or shadow.
						"md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-0 md:peer-data-[variant=inset]:m-0 md:peer-data-[variant=inset]:rounded-none md:peer-data-[variant=inset]:shadow-none",
						osProduct && "m-0",
						// Inset mode normally keeps mr-2 so the canvas clears the window
						// edge; when the Ask Ryu rail is docked it plays the same role as
						// the left sidebar (ml-0), so drop the right margin and let the
						// canvas abut the flush rail.
						assistantMode === "sidebar" &&
							sidebarVariant === "inset" &&
							!isMobile &&
							"md:mr-0"
					)
				)}
				id={layoutStyles.assistantReserve}
				motion="assistant-dock"
				style={cssVariables5}
			>
				{interfaceSurface ? (
					<Suspense fallback={null}>
						<InterfaceSurface
							canSwitchToConsole={canSwitchToConsole}
							descriptor={activeInterface}
						/>
					</Suspense>
				) : osProduct ? (
					<Suspense fallback={null}>
						<OsDesktopSurfaceWithApps
							activeWindowId={activeTabId}
							canSwitchToConsole={canSwitchToConsole}
							onActivateWindow={focusTab}
							onCloseWindow={closeTab}
							onOpenApp={(app) => openTab(app.path, { title: app.label })}
							windows={osWindows}
						/>
					</Suspense>
				) : (
					<>
						{/* Tab panels fill the entire inset and scroll UNDER the frosted
				    titlebar (which is absolutely positioned on top). Each page wrapper
				    is padded down by the titlebar height so its own header clears the
				    tab strip while content reads as one continuous glass surface. */}
						{alternateTabView ? (
							<AlternateTabPanes
								activeSplit={activeSplit}
								activeTabId={activeTabId}
								closeTab={closeTab}
								contentRef={contentRef}
								cssVariables6={cssVariables6}
								focusTab={focusTab}
								isMobile={isMobile}
								splitLayout={splitLayout}
								tabLayout={tabLayout}
								tabs={tabs}
								titleBarActions={titleBarActions}
								titleBarClearsContent={titleBarClearsContent}
							/>
						) : (
							<WorkbenchCenter
								centerHasRouteItems={centerHasRouteItems}
								closeTab={closeTab}
								dispatchWorkbench={dispatchWorkbench}
								isMobile={isMobile}
								navClusterReserve={navClusterReserve}
								navigationMoved={navigationMoved}
								pageActionsMargin={pageActionsMargin}
								panelProps={sidebarPanelProps}
							/>
						)}
					</>
				)}
				{/* Frosted titlebar overlays the content (absolute, z-10). */}
				{!osProduct && alternateTabView && (
					<TitleBar
						navClusterReserve={navClusterReserve}
						pageActionsMargin={pageActionsMargin}
					/>
				)}

				{/* Status banners stack as inline strips just below the titlebar so
				    they never push the content down or break the under-the-bar
				    scroll. When the titlebar auto-hides, they sit at the top edge.
				    z-40 lifts them above the workbench chrome layer (z-30) that hosts
				    the titlebar and its blur fade, and below dialogs (z-50). */}
				{!osProduct && (
					<div
						className={cn(
							"pointer-events-none absolute right-0 left-0 z-40 flex flex-col [&>*]:pointer-events-auto",
							titleBarClearsContent ? "top-14" : "top-0"
						)}
					>
						<ShellBanners
							botProduct={botProduct}
							reconnectRetryState={reconnectRetryState}
						/>
						{canUpdateDesktopApp ? <AutoUpdater /> : null}
					</div>
				)}
			</SidebarInset>

			<ConversationOverlays
				assistantMode={assistantMode}
				chatPaneVisible={chatPaneVisible}
				loadMessages={loadMessages}
				quick={quick}
				showAssistantDock={showAssistantDock}
			/>
		</TabDndProvider>
	);
}
