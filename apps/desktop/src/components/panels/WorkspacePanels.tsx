import { useIsMobile } from "@ryu/ui/hooks/use-mobile.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useContext, useEffect, useRef, useState } from "react";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import {
	sidebarFloatingChrome,
	useSidebarVariant,
} from "@/src/hooks/useSidebarVariant.ts";
import { useTitleBarClearsContent } from "@/src/hooks/useTitleBarClearsContent.ts";
import { usePublishConversationPanelSource } from "@/src/workbench/conversation-panel-registry.ts";
import { useWorkbenchDockBridge } from "@/src/workbench/workbench-dock-bridge.tsx";
import { WorkbenchChatPanels } from "./WorkbenchChatPanels.tsx";
import { SessionBoxWorkbenchBridge } from "./workspace-panels/tab-content.tsx";
import { DockRouteHostContext } from "./workspace-panels/tab-model.ts";
import { useResizeHandle } from "./workspace-panels/use-resize-handle.ts";

export { DockPageBoundary } from "./workspace-panels/dock-route-page.tsx";
export type { SubagentView } from "./workspace-panels/native-dock-panels.tsx";
export { PanelTabBar } from "./workspace-panels/panel-tab-bar.tsx";
export {
	PanelToggleButtons,
	type PanelToggleButtonsProps,
} from "./workspace-panels/panel-toggle-buttons.tsx";
export {
	type FileReviewRequest,
	PatchDiffPanel,
} from "./workspace-panels/patch-diff-panel.tsx";
export {
	ConversationPanelContent,
	DockKindIcon,
	ProjectDockTabContent,
} from "./workspace-panels/tab-content.tsx";
export { routeAppIcon } from "./workspace-panels/tab-model.ts";

import {
	renderBottomDockCard,
	renderRightDockCard,
} from "./workspace-panels/dock-panel-cards.tsx";
import { dockTabActions } from "./workspace-panels/dock-tab-actions.ts";
import { useDockPanelRequests } from "./workspace-panels/use-dock-panel-requests.ts";
import { useDockTabTypes } from "./workspace-panels/use-dock-tab-types.ts";
import { useWorkspaceDockTabs } from "./workspace-panels/use-workspace-dock-tabs.ts";
import {
	MIN_CHAT_WIDTH,
	PANEL_GUTTER,
	PEEK_HIDE_DELAY,
	PINNED_PANEL_WIDTH,
	renderWorkspaceDockLayout,
} from "./workspace-panels/workspace-dock-layout.tsx";
import type { WorkspacePanelsProps } from "./workspace-panels/workspace-panels-types.ts";

export type { WorkspacePanelsProps } from "./workspace-panels/workspace-panels-types.ts";

/**
 * The workspace docks around a page's content.
 *
 * Where the workbench frame is mounted ({@link useWorkbenchDockBridge}), the
 * chat's panels open as workbench tabs instead ({@link WorkbenchChatPanels});
 * these docks remain for the layouts without the frame.
 *
 * Inside a page that is ITSELF hosted in a dock ({@link DockRoutePage}), this
 * renders the content bare: `/chat` is a hostable page and ChatPage's root is a
 * `WorkspacePanels`, so without the short-circuit the dock would mount a dock
 * inside itself, recursively. The check lives in a wrapper rather than an early
 * return because the implementation opens with a dozen hooks.
 */
export function WorkspacePanels(props: WorkspacePanelsProps) {
	const hostedInDock = useContext(DockRouteHostContext);
	const workbenchDocks = useWorkbenchDockBridge();
	if (hostedInDock) {
		return <>{props.children}</>;
	}
	// With the workbench frame mounted, the chat's panels are workbench tabs in
	// the shared Right/Bottom panes rather than docks of its own.
	if (workbenchDocks) {
		const conversationId = props.contextView?.conversationId;
		return (
			<>
				{conversationId ? (
					<SessionBoxWorkbenchBridge
						bridge={workbenchDocks}
						conversationId={conversationId}
					/>
				) : null}
				<WorkbenchChatPanels {...props} bridge={workbenchDocks} />
			</>
		);
	}
	return <WorkspacePanelsImpl {...props} />;
}

function WorkspacePanelsImpl({
	children,
	agentActivityAvailable = false,
	agentActivityPanel,
	agentActivityRequest,
	fileReviewRequest,
	fileSearchRequest,
	folder,
	cowork,
	bottomOpen,
	onBottomOpenChange,
	rightOpen,
	onRightOpenChange,
	subagentRequest,
	artifactRequest,
	inspectorRequest,
	contextRequest,
	contextView,
	collectionRequest,
	renderPinnedSummary,
}: WorkspacePanelsProps) {
	const { canUseNativeShell } = useAppSurface();
	// Publish this chat's live panel data so Context/Sources/Subagents tabs
	// placed anywhere in the workbench read this conversation (and only it).
	usePublishConversationPanelSource(contextView?.conversationId, {
		contextView: contextView ?? null,
		cowork,
	});
	const {
		addProjectTab,
		bottomActiveUid,
		bottomLocal,
		bottomTabs,
		currentTabId,
		projectTabs,
		removeProjectTab,
		rightActiveUid,
		rightLocal,
		rightTabs,
		setBottomActiveUid,
		setProjectSide,
		setRightActiveUid,
		toggleProjectPin,
		visibleBottomProject,
		visibleRightProject,
	} = useWorkspaceDockTabs({
		bottomOpen,
		folder,
		onBottomOpenChange,
		onRightOpenChange,
		rightOpen,
	});
	const {
		bottomTabTypes,
		dockPanels,
		iconForKind,
		rightTabTypes,
		setSubagentView,
		subagentView,
	} = useDockTabTypes({ agentActivityAvailable, canUseNativeShell });
	const { inspectorView, isFocusedWindowTab } = useDockPanelRequests({
		agentActivityRequest,
		artifactRequest,
		bottomLocal,
		bottomOpen,
		collectionRequest,
		contextRequest,
		contextView,
		cowork,
		fileReviewRequest,
		fileSearchRequest,
		inspectorRequest,
		onBottomOpenChange,
		onRightOpenChange,
		rightLocal,
		rightOpen,
		setBottomActiveUid,
		setRightActiveUid,
		setSubagentView,
		subagentRequest,
		visibleBottomProject,
		visibleRightProject,
	});

	const [bottomHeight, setBottomHeight] = useState(260);
	const [rightWidth, setRightWidth] = useState(340);

	const { onMouseDown: resizeBottom, isResizing: bottomResizing } =
		useResizeHandle("vertical", setBottomHeight);
	const { onMouseDown: resizeRight, isResizing: rightResizing } =
		useResizeHandle("horizontal", setRightWidth);
	// Hover-peek: when a panel is closed (undocked), hovering its edge slides a
	// floating copy in; it auto-hides shortly after the pointer leaves. Mirrors
	// the left sidebar's floating-on-hover behaviour from Layout.tsx.
	const [rightPeek, setRightPeek] = useState(false);
	const rightHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const showRightPeek = () => {
		if (rightHideTimer.current) {
			clearTimeout(rightHideTimer.current);
		}
		rightHideTimer.current = null;
		setRightPeek(true);
	};
	const hideRightPeek = () => {
		if (rightHideTimer.current) {
			clearTimeout(rightHideTimer.current);
		}
		rightHideTimer.current = setTimeout(
			() => setRightPeek(false),
			PEEK_HIDE_DELAY
		);
	};

	// Drop any pending peek when the panel becomes docked.
	useEffect(() => {
		if (rightOpen) {
			setRightPeek(false);
		}
	}, [rightOpen]);

	const activeBottomTab = bottomTabs.find((t) => t.uid === bottomActiveUid);
	const activeRightTab = rightTabs.find((t) => t.uid === rightActiveUid);

	const {
		addBottomTab,
		addRightTab,
		closeBottomAll,
		closeBottomOthers,
		closeBottomTab,
		closeRightAll,
		closeRightOthers,
		closeRightTab,
		moveTabToBottom,
		moveTabToRight,
		onTogglePin,
		pinDisabledReason,
	} = dockTabActions({
		addProjectTab,
		bottomLocal,
		bottomOpen,
		bottomTabTypes,
		currentTabId,
		folder,
		onBottomOpenChange,
		onRightOpenChange,
		projectTabs,
		removeProjectTab,
		rightLocal,
		rightOpen,
		rightTabTypes,
		setBottomActiveUid,
		setProjectSide,
		setRightActiveUid,
		toggleProjectPin,
		visibleBottomProject,
		visibleRightProject,
	});

	// Floating = rounded card rail (matches left shadcn sidebar-inner). Inset =
	// flush inside the already-carded SidebarInset canvas — no nested chrome.
	const [sidebarVariant] = useSidebarVariant();
	const floatingChrome = sidebarVariant === "floating";
	// Docked panels start below the frosted titlebar (floating chrome clears its
	// top-2 offset at 58px; inset chrome starts at 56px, the bar's fixed 8px
	// offset plus h-12, the same line the shell banners use). When the bar
	// auto-hides the panels take the full height instead — no leftover gap.
	const titleBarClearsContent = useTitleBarClearsContent();
	const dockTop =
		titleBarClearsContent && floatingChrome
			? "top-[58px]"
			: titleBarClearsContent
				? "top-14"
				: "top-0";
	const panelChrome = cn(
		"flex flex-1 flex-col overflow-hidden bg-sidebar",
		floatingChrome && sidebarFloatingChrome
	);

	const bottomCard = (onClosePanel: () => void) =>
		renderBottomDockCard(
			{
				activeBottomTab,
				addBottomTab,
				agentActivityPanel,
				bottomActiveUid,
				bottomTabTypes,
				bottomTabs,
				closeBottomAll,
				closeBottomOthers,
				closeBottomTab,
				contextView,
				dockPanels,
				fileReviewRequest,
				floatingChrome,
				folder,
				iconForKind,
				isFocusedWindowTab,
				moveTabToRight,
				onTogglePin,
				panelChrome,
				pinDisabledReason,
				setBottomActiveUid,
			},
			onClosePanel
		);

	const rightCard = (onClosePanel: () => void) =>
		renderRightDockCard(
			{
				activeRightTab,
				addRightTab,
				agentActivityPanel,
				closeRightAll,
				closeRightOthers,
				closeRightTab,
				contextView,
				cowork,
				dockPanels,
				fileReviewRequest,
				floatingChrome,
				folder,
				iconForKind,
				inspectorView,
				isFocusedWindowTab,
				moveTabToBottom,
				onTogglePin,
				panelChrome,
				pinDisabledReason,
				rightActiveUid,
				rightTabTypes,
				rightTabs,
				setRightActiveUid,
				setSubagentView,
				subagentView,
			},
			onClosePanel
		);

	const bottomResizeHandle = (
		<div
			className="group flex h-3 w-full shrink-0 cursor-row-resize items-center justify-center"
			onMouseDown={(e) => resizeBottom(e, bottomHeight)}
		>
			<div className="h-[3px] w-10 rounded-full bg-border/50 opacity-0 transition-opacity group-hover:opacity-100" />
		</div>
	);

	const rightResizeHandle = (
		<div
			className="group flex h-full w-3 shrink-0 cursor-col-resize items-center justify-center"
			onMouseDown={(e) => resizeRight(e, rightWidth)}
		>
			<div className="h-10 w-[3px] rounded-full bg-border/50 opacity-0 transition-opacity group-hover:opacity-100" />
		</div>
	);

	// A panel is visible when docked open OR being hover-peeked while closed. The
	// docked state also drives an in-flow spacer that pushes the chat (shadcn's
	// sidebar approach: one fixed panel + an animated gap), so the single mounted
	// panel slides for both the toggle and the peek — no duplicate instances, no
	// snap.
	const rightVisible = rightOpen || rightPeek;

	// ── Pinned summary column (chat sidebar stacked against the right dock) ─────
	//
	// Docked by default: its own in-flow spacer pushes the chat, exactly like the
	// right dock, and the two stack (pinned column left of the right panel) so
	// both can be open at once. Measured against the container width: when
	// docking it would squeeze the chat below MIN_CHAT_WIDTH, the panel
	// auto-demotes to a floating overlay that stops affecting content width —
	// the same idea as the left sidebar's floating mode. The demotion check uses
	// the would-be-docked width, not the current mode, so it can't oscillate.
	const containerRef = useRef<HTMLDivElement>(null);
	const [containerWidth, setContainerWidth] = useState(0);
	const [containerHeight, setContainerHeight] = useState(0);
	useEffect(() => {
		const el = containerRef.current;
		if (!el) {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect;
			if (rect) {
				setContainerWidth(rect.width);
				setContainerHeight(rect.height);
			}
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	// Phone widths have no room for a docked side column: the right panel stops
	// pushing the chat and becomes a full-width overlay instead, and the
	// pointer-only hover-peek and drag-to-resize handles stand down. The stored
	// `rightWidth` is left alone so a wide viewport restores the docked rail.
	const isMobile = useIsMobile();
	const rightOverlay = isMobile && rightOpen;
	const rightPanelWidth = isMobile ? containerWidth : rightWidth + PANEL_GUTTER;
	// Never let the bottom dock swallow the chat: cap it so at least 120px of
	// message column survives. Load-bearing on short viewports, where the 260px
	// default is most of the screen.
	const maxBottomHeight =
		containerHeight > 0 ? Math.max(120, containerHeight - 120) : bottomHeight;
	const effectiveBottomHeight = Math.min(bottomHeight, maxBottomHeight);

	const pinnedRequested = Boolean(renderPinnedSummary);
	// An overlaid right panel doesn't reserve width, so it must not shift the
	// pinned column's offset or feed the demotion measurement either.
	const rightDockWidth =
		rightOpen && !rightOverlay ? rightWidth + PANEL_GUTTER : 0;
	const pinnedColumnWidth = PINNED_PANEL_WIDTH + PANEL_GUTTER;
	const pinnedFloating =
		pinnedRequested &&
		containerWidth > 0 &&
		containerWidth - rightDockWidth - pinnedColumnWidth < MIN_CHAT_WIDTH;
	const pinnedDocked = pinnedRequested && !pinnedFloating;
	const closeBottom = () => {
		onBottomOpenChange(false);
	};
	const closeRight = () => {
		onRightOpenChange(false);
		setRightPeek(false);
	};

	return renderWorkspaceDockLayout({
		bottomCard,
		bottomOpen,
		bottomResizeHandle,
		bottomResizing,
		children,
		closeBottom,
		closeRight,
		containerRef,
		dockTop,
		effectiveBottomHeight,
		floatingChrome,
		hideRightPeek,
		isMobile,
		pinnedColumnWidth,
		pinnedDocked,
		pinnedFloating,
		renderPinnedSummary,
		rightCard,
		rightDockWidth,
		rightOpen,
		rightPanelWidth,
		rightResizeHandle,
		rightResizing,
		rightVisible,
		showRightPeek,
		titleBarClearsContent,
	});
}
