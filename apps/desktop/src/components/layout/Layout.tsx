import { AgentAvailabilityProvider } from "@ryu/blocks/desktop/agent-availability.tsx";
import {
	HotkeysProvider,
	useHotkey,
	useOptionalHotkeyBinding,
} from "@ryu/hotkeys/react";
import {
	readSidebarOpenPreference,
	SidebarInset,
	SidebarProvider,
	useSidebar,
} from "@ryu/ui/components/sidebar.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { useIsMobile } from "@ryu/ui/hooks/use-mobile.ts";
import {
	clampWithRubberband,
	createVelocityTracker,
	projectEndpoint,
} from "@ryu/ui/lib/gesture.ts";
import { haptic } from "@ryu/ui/lib/haptics.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties as LayoutCSSProperties } from "react";
import {
	type ComponentProps,
	type CSSProperties,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useLocation } from "react-router-dom";
import type { AttachedImage } from "@/components/agent-elements/input-bar.tsx";
import { PluginAvatarContributions } from "@/src/components/avatar/PluginAvatarContributions.tsx";
import { ChatDisplayPrefs } from "@/src/components/chat/ChatDisplayPrefsProvider.tsx";
import { QuickPreview } from "@/src/components/chat/QuickPreview.tsx";
import { QuickReplyComposer } from "@/src/components/chat/QuickReplyComposer.tsx";
import { DeepLinkController } from "@/src/components/deeplink/DeepLinkController.tsx";
import { AnimatedTitle } from "@/src/components/layout/animated-title.tsx";
import { EmptyTabsState } from "@/src/components/layout/EmptyTabsState.tsx";
import { InfiniteTabsCanvas } from "@/src/components/layout/InfiniteTabsCanvas.tsx";
import { ScrollableTabsView } from "@/src/components/layout/ScrollableTabsView.tsx";
import { DesktopReportHost } from "@/src/components/marketplace/report-host.tsx";
import { MediaPipDock } from "@/src/components/media/MediaPip.tsx";
import { ProjectDockHost } from "@/src/components/panels/ProjectDockHost.tsx";
import { SupportAccessBanner } from "@/src/components/settings/support-access-banner.tsx";
import { ConnectionStatusToast } from "@/src/components/shell/ConnectionStatusToast.tsx";
import { ReconnectRetryBanner } from "@/src/components/shell/ReconnectRetryBanner.tsx";
import { SafeModeBanner } from "@/src/components/shell/SafeModeBanner.tsx";
import { SkillDistributionProvider } from "@/src/components/skills/SkillDistributionProvider.tsx";
import { AutoUpdater } from "@/src/components/updater/AutoUpdater.tsx";
import {
	useAppSurface,
	useHostBackButtonSync,
} from "@/src/contexts/app-surface-context.tsx";
import {
	ChatHistoryProvider,
	useChatHistoryContext,
} from "@/src/contexts/ChatHistoryContext.tsx";
import { SpacesProvider } from "@/src/contexts/SpacesContext.tsx";
import { SystemStatusProvider } from "@/src/contexts/SystemStatusContext.tsx";
import type { InitialTab, Tab } from "@/src/contexts/TabsContext.tsx";
import {
	CurrentTabIdProvider,
	findSplit,
	IsActiveTabProvider,
	TabsProvider,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import {
	TitleBarProvider,
	useTitleBarContext,
} from "@/src/contexts/TitleBarContext.tsx";
import {
	useAppShellPath,
	useAppShellRoutes,
} from "@/src/contributions/app-shell-routes.ts";
import { seedBuiltinRoutes } from "@/src/contributions/builtins.ts";
import { RouteOutlet } from "@/src/contributions/RouteOutlet.tsx";
import { useCompanionAlias } from "@/src/contributions/use-companion-alias.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgentAmbientAudio } from "@/src/hooks/useAgentAmbientAudio.ts";
import { useApprovalEvents } from "@/src/hooks/useApprovalEvents.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { useAssistantPageReset } from "@/src/hooks/useAssistantPageReset.ts";
import { useConsoleAccess } from "@/src/hooks/useConsoleAccess.ts";
import { usePluginBackgroundSync } from "@/src/hooks/useContributedBackgrounds.ts";
import { usePluginThemeSync } from "@/src/hooks/useContributedThemes.ts";
import { useCreditAlertEvents } from "@/src/hooks/useCreditAlertEvents.ts";
import { useDesktopNotificationsStream } from "@/src/hooks/useDesktopNotificationsStream.ts";
import { useDownloadsStream } from "@/src/hooks/useDownloadsStream.ts";
import { useEditorUploader } from "@/src/hooks/useEditorUploader.ts";
import { useFolderProjectMigration } from "@/src/hooks/useFolderProjectMigration.ts";
import { LoginApprovalEvents } from "@/src/hooks/useLoginApprovalEvents.tsx";
import { useMeetingStream } from "@/src/hooks/useMeetingStream.ts";
import { useMonitorAlertsStream } from "@/src/hooks/useMonitorAlertsStream.ts";
import { useNavigationEvents } from "@/src/hooks/useNavigationEvents.ts";
import { useNotificationEvents } from "@/src/hooks/useNotificationEvents.ts";
import { useOpenConversationEvents } from "@/src/hooks/useOpenConversationEvents.ts";
import {
	usePluginContributionRoutes,
	usePluginContributionsLiveRefresh,
	usePluginContributionTabIcons,
} from "@/src/hooks/usePluginContributions.ts";
import { usePresenceSync } from "@/src/hooks/usePresenceSync.ts";
import { useQuestEvents } from "@/src/hooks/useQuestEvents.ts";
import { useReconnectRetry } from "@/src/hooks/useReconnectRetry.ts";
import { useRegisterEditorAi } from "@/src/hooks/useRegisterEditorAi.ts";
import { useSidebarVariant } from "@/src/hooks/useSidebarVariant.ts";
import { useTabLayout } from "@/src/hooks/useTabLayout.ts";
import {
	DEFAULT_SIDEBAR_WIDTH,
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	SIDEBAR_WIDTH_KEY,
} from "@/src/hooks/useThemePreset.ts";
import { useTitleBarClearsContent } from "@/src/hooks/useTitleBarClearsContent.ts";
import { useUserAvailability } from "@/src/hooks/useUserAvailability.ts";
import { InterfaceSurface } from "@/src/interfaces/InterfaceSurface.tsx";
import { configureInterfaceEscape } from "@/src/interfaces/interface-escape-keys.ts";
import { useActiveInterface } from "@/src/interfaces/interface-store.ts";
import {
	backToChat,
	openInterfaceSwitcher,
} from "@/src/interfaces/interface-switcher.ts";
import { useSyncContributedInterfaces } from "@/src/interfaces/use-contributed-interfaces.ts";
import { useInterfaceActive } from "@/src/interfaces/use-interface-active.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { fetchRecentActivity } from "@/src/lib/api/clips.ts";
import { getCurrentContext } from "@/src/lib/api/shadow.ts";
import {
	buildClipsQuickAttachPrompt,
	CLIPS_QUICK_ATTACH_EVENT,
	clipsQuickAttachDestinationFromStatus,
	isChatRoute,
	resolveClipsQuickAttachTarget,
} from "@/src/lib/clips-quick-attach.ts";
import { setCrashRoute } from "@/src/lib/crash-context.ts";
import {
	DASHBOARDS_HOME_BUTTON_ID,
	DASHBOARDS_PLUGIN_ID,
} from "@/src/lib/dashboards/app.ts";
import {
	EXTENSION_DESKTOP_LAYOUT_READY_EVENT,
	EXTENSION_QUICK_MESSAGE_EVENT,
	extensionQuickMessageSeedFromEvent,
	extensionQuickMessageTab,
	takeExtensionQuickMessageSeed,
} from "@/src/lib/extension-quick-message.ts";
import { toggleFullscreen } from "@/src/lib/fullscreen.ts";
import { DESKTOP_HOTKEYS } from "@/src/lib/hotkeys/actions.ts";
import { coreKvHotkeyStorage } from "@/src/lib/hotkeys/storage.ts";
import { onboardingInitialTab } from "@/src/lib/onboarding-navigation.ts";
import { isRyuBot } from "@/src/lib/product.ts";
import { useProductMode, useProductModeStore } from "@/src/lib/product-mode.ts";
import { installRoutePrefetch } from "@/src/lib/route-prefetch.ts";
import {
	isDetachedTabWindow,
	readTabTransfer,
} from "@/src/lib/tab-transfer.ts";
import { invokeWhenReady, listenWhenReady } from "@/src/lib/tauri-ready.ts";
import { windowChromeLayout } from "@/src/lib/window-chrome-layout.ts";
import { useLiveActivities } from "@/src/live/useLiveActivities.ts";
import { useAssistantStore } from "@/src/store/useAssistantStore.ts";
import { useChatHotkeyTargets } from "@/src/store/useChatHotkeyTargets.ts";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { useQuickReplyStore } from "@/src/store/useQuickReplyStore.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import {
	DesktopWorkbenchProvider,
	useDesktopWorkbench,
} from "@/src/workbench/DesktopWorkbenchContext.tsx";
import { RouteWorkbenchItem } from "@/src/workbench/RouteWorkbenchItem.tsx";
import { ShellWorkbenchItem } from "@/src/workbench/ShellWorkbenchItem.tsx";
import {
	useWorkbenchDockBridgeValue,
	WorkbenchToolsProvider,
} from "@/src/workbench/useWorkbenchTools.tsx";
import { WorkbenchDockRequests } from "@/src/workbench/WorkbenchDockRequests.tsx";
import { WorkbenchItemHost } from "@/src/workbench/WorkbenchItemHost.tsx";
import { renderWorkbenchItemIcon } from "@/src/workbench/WorkbenchItemIcon.tsx";
import {
	CompatibilityWorkbenchFrame,
	workbenchCenterHasRouteItems,
} from "@/src/workbench/WorkbenchLayout.tsx";
import {
	DESKTOP_SHELL_REGIONS,
	useWorkbenchToolsContext,
} from "@/src/workbench/workbench-chrome.tsx";
import { workbenchLayoutCommands } from "@/src/workbench/workbench-commands.ts";
import {
	useMarkWorkbenchDocksActive,
	WorkbenchDockBridgeProvider,
} from "@/src/workbench/workbench-dock-bridge.tsx";
import { AssistantDock } from "../assistant/AssistantDock.tsx";
import { AssistantPanel } from "../assistant/AssistantPanel.tsx";
import {
	OsDesktopSurfaceWithApps,
	type OsWindow,
} from "../os/OsDesktopSurface.tsx";
import { AppSidebar, SidebarPanelContent } from "./AppSidebar.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { InterfaceSwitcherDialog } from "./InterfaceSwitcherDialog.tsx";
import layoutStyles from "./Layout.module.css";
import { PullRequestAutomationWatcher } from "./PullRequestAutomationWatcher.tsx";
import { SplitDropZones } from "./SplitDropZones.tsx";
import { SaveSplitPresetDialog } from "./SplitPresetMenu.tsx";
import splitStyles from "./SplitView.module.css";
import type { PaneCssVariables } from "./SplitView.tsx";
import {
	computeSplitLayout,
	paneNeedsTopClearance,
	paneRectStyle,
	SplitGutters,
} from "./SplitView.tsx";
import { TabGlyph, TitleBar, useTabBusy } from "./TitleBar.tsx";
import { TitlebarPage } from "./TitlebarPage.tsx";
import { TabDndProvider, useTabDnd } from "./tabDnd.tsx";
import { WindowNavigationCluster } from "./WindowNavigationCluster.tsx";

interface LayoutCssVariables extends CSSProperties {
	"--ryu-titlebar-inset"?: string;
	"--sidebar-width"?: string;
}

// Populate the contribution registry with every built-in route BEFORE first
// render, so `RouteOutlet` (which resolves a tab's path through the registry)
// can render built-in tabs. Idempotent — safe to call at module load.
seedBuiltinRoutes();

const isMac = navigator.userAgent.includes("Mac");
const EMPTY_OS_WINDOWS: OsWindow[] = [];

/** Docked-sidebar resize bounds. */
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 480;
/**
 * Collapse the sidebar when the rail drag was HEADED below this width, even if
 * the pointer lifted before reaching it. Sits under the minimum so only a
 * deliberate inward gesture — a real flick, or a drag that already fought the
 * rubber-band past the min — can trigger it.
 */
const SIDEBAR_COLLAPSE_PROJECTION = 140;

// Floating chrome at the bottom-left of each split pane: a title pill (always
// visible; fades only when the pointer is near it so content behind stays
// reachable) plus, on the focused pane, the page actions which never fade.
function PaneBadge({
	actions,
	activeSplit,
	containerRef,
	focused,
	tab,
}: {
	actions?: ReactNode;
	activeSplit: boolean;
	containerRef: React.RefObject<HTMLElement | null>;
	focused: boolean;
	tab: Tab;
}) {
	const pillRef = useRef<HTMLDivElement>(null);
	const [pillOpacity, setPillOpacity] = useState(1);
	const busy = useTabBusy(tab);

	// containerRef is stable
	useEffect(() => {
		if (!activeSplit) {
			return;
		}
		const container = containerRef.current;
		if (!container) {
			return;
		}

		const FADE_RADIUS = 120;

		const onMove = (e: PointerEvent) => {
			const pill = pillRef.current;
			if (!pill) {
				return;
			}
			const rect = pill.getBoundingClientRect();
			const cx = rect.left + rect.width / 2;
			const cy = rect.top + rect.height / 2;
			const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
			// Far = fully opaque; near the pill = transparent so content behind is
			// clickable. Actions sit beside the pill and are not part of this fade.
			setPillOpacity(Math.min(1, dist / FADE_RADIUS));
		};

		const onLeave = () => setPillOpacity(1);

		container.addEventListener("pointermove", onMove);
		container.addEventListener("pointerleave", onLeave);
		return () => {
			container.removeEventListener("pointermove", onMove);
			container.removeEventListener("pointerleave", onLeave);
		};
	}, [activeSplit, containerRef]);

	if (!activeSplit) {
		return null;
	}

	const cssVariables1: LayoutCssVariables = {
		"--desktop-inline1-opacity": pillOpacity,
	};
	return (
		// Fixed row height (h-8, the action buttons' size) so the pill sits at the
		// same spot whether or not the focused pane's actions are beside it —
		// otherwise the row collapses to the pill's own height on unfocused panes
		// and the badge visibly jumps/resizes every time focus moves.
		<div className="pointer-events-none absolute bottom-2 left-2 z-10 flex h-8 items-center gap-1.5">
			<div
				className={cn(
					cn(
						"flex h-6 items-center gap-1.5 rounded-full px-2.5 backdrop-blur-sm transition-opacity duration-300",
						focused
							? "bg-primary text-primary-foreground"
							: "bg-muted/70 text-muted-foreground ring-1 ring-border/20"
					),
					layoutStyles.inline1
				)}
				ref={pillRef}
				style={cssVariables1}
			>
				<span
					className={cn(
						"flex size-3 shrink-0 items-center justify-center",
						focused ? "text-primary-foreground" : "text-muted-foreground"
					)}
				>
					<TabGlyph
						busy={busy}
						busySpeed={tab.busySpeed}
						className="size-3"
						logoSize="12px"
						path={tab.path}
						unloaded={tab.unloaded}
					/>
				</span>
				{busy && !tab.unloaded ? (
					<span
						className={cn(
							"an-text-shimmer an-text-shimmer--active max-w-32 truncate font-medium text-xs",
							layoutStyles.authored1
						)}
					>
						<AnimatedTitle text={tab.title} />
					</span>
				) : (
					<span className="max-w-32 truncate font-medium text-xs">
						<AnimatedTitle text={tab.title} />
					</span>
				)}
			</div>
			{focused && actions ? (
				<div
					className="pointer-events-auto flex h-8 shrink-0 flex-row items-center gap-1 rounded-2xl bg-background/80 px-1 shadow-lg ring-1 ring-border/40 backdrop-blur-sm"
					data-tauri-drag-region={false}
				>
					{actions}
				</div>
			) : null}
		</div>
	);
}

interface LayoutContentProps {
	nativeWindowChrome: boolean;
	onSidebarWidthChange: (w: number) => void;
	sidebarWidth: number;
}

/** Joins the workbench strips to the shell's one tab drag session. Lives
    inside TabDndProvider, which LayoutContent itself renders. */
function DraggableWorkbenchFrame(
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

function LayoutContent({
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
	const {
		activeConversationId,
		conversations,
		loadMessages,
		setActiveConversationId,
		deleteConversation,
		createConversation,
	} = useChatHistoryContext();

	// One app-wide subscription to Core's download SSE stream → downloads store,
	// powering the global DownloadCenter overlay below.
	useDownloadsStream();

	// One app-wide feed of live activities (agent runs / downloads / approvals /
	// meetings / contributed) → the shared live-activity store that powers the
	// empty-shell "Dynamic Island" dock and the sidebar Live section.
	useLiveActivities();
	// One singleton ambient player driven by the aggregate agent-run state. The
	// plugin contribution supplies the source; this hook supplies lifecycle.
	useAgentAmbientAudio();

	// One app-wide subscription to Core's monitor-alert SSE stream → in-app toast
	// + native OS notification when a watched site changes.
	useMonitorAlertsStream();

	// App-wide subscription to Core's meeting-event SSE stream → auto-detection
	// toast + live transcript/notes refresh on the Meetings page.
	useMeetingStream();

	// App-wide subscription to Core's quest-event SSE stream → "looks done?"
	// suggestion toast + auto-completion announcements + live quest refresh.
	useQuestEvents();

	// App-wide subscription to Core's approval-inbox SSE stream → "approval
	// needed" toast + OS notification + live approvals refresh.
	useApprovalEvents();

	// App-wide subscription to Core's desktop-notification SSE stream → in-app
	// toast + native OS notification from built-in agent actions (notify.desktop).
	useDesktopNotificationsStream();

	// Cloud credit alerts are edge-triggered after the server's atomic threshold
	// claim; keep this separate from Core's notification streams.
	useCreditAlertEvents();

	// App-wide subscription to Core's per-user notification SSE stream → toast +
	// OS notification for user-targeted pings (notify_user workflow node) and a
	// live Inbox feed. Distinct from the broadcast stream above (Core filters
	// user-targeted pings out of /api/events/all), so the two never double-toast.
	useNotificationEvents();

	// App-wide subscription to agent/app shell navigation requests. Only the main
	// window consumes them; tear-off and companion windows stay independent.
	useNavigationEvents();

	// Opt-in plugin host for chats that were interrupted by a Wi-Fi/LAN or node
	// outage. The hook stays app-wide so background tabs are included; its feature
	// detection is driven by Core's enabled-plugin contribution feed.
	const reconnectRetryState = useReconnectRetry();

	// Point the Plate editor's media uploads at Core's local media store.
	useEditorUploader();

	// Register the editor's inline-AI model (routed via the Gateway) from prefs.
	useRegisterEditorAi();

	// Register a navigable /plugin/<id> route for each enabled plugin companion
	// (and tear it down when the plugin is disabled) into the same contribution
	// registry the built-ins seed, so RouteOutlet renders it. Called once here
	// because LayoutContent is always mounted; a disabled plugin's route then
	// resolves to null (blank) — the "route disappears" behavior of #446.
	usePluginContributionRoutes();
	// Same seam for the shell pages an APP owns (the Home dashboard): the route is
	// minted at the path the app's manifest declares, and disappears with the app.
	useAppShellRoutes();
	usePluginContributionTabIcons();
	// Warm a route's chunk (and its preloaded data) on hover/focus of any
	// `data-prefetch-path` link, then idle-warm the visible ones.
	useEffect(() => installRoutePrefetch(), []);

	// Live refresh for the contributions cache: Core broadcasts on the
	// `system:plugins` realtime room after every plugin enable/disable/grants
	// change; this invalidates the shared react-query read immediately. Remote
	// nodes fail-soft to the stale-window poll above.
	usePluginContributionsLiveRefresh();

	// Mirror marketplace-installed themes (`contributes.themes`) into the local
	// resolution cache the theme picker and `initTheme()` read. Mounted here, not in
	// Appearance settings: a theme must resolve at boot and survive the user never
	// opening settings at all.
	usePluginThemeSync();
	usePluginBackgroundSync();

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
	const extensionLayoutReadyDispatched = useRef(false);
	useEffect(() => {
		if (surface !== "extension") {
			return;
		}
		const openSeed = (seed: string | undefined) => {
			if (!seed) {
				return;
			}
			const intent = extensionQuickMessageTab(seed);
			if (intent) {
				openTab(intent.path, intent.options);
			}
		};
		const handleSeed = (event: Event) => {
			const eventSeed = extensionQuickMessageSeedFromEvent(event);
			const storedSeed = takeExtensionQuickMessageSeed(window.localStorage);
			openSeed(eventSeed ?? storedSeed);
		};

		window.addEventListener(EXTENSION_QUICK_MESSAGE_EVENT, handleSeed);
		if (!extensionLayoutReadyDispatched.current) {
			extensionLayoutReadyDispatched.current = true;
			window.dispatchEvent(new Event(EXTENSION_DESKTOP_LAYOUT_READY_EVENT));
		}
		const initialSeed = takeExtensionQuickMessageSeed(window.localStorage);
		const initialSeedFrame = initialSeed
			? window.requestAnimationFrame(() => openSeed(initialSeed))
			: null;
		return () => {
			window.removeEventListener(EXTENSION_QUICK_MESSAGE_EVENT, handleSeed);
			if (initialSeedFrame !== null) {
				window.cancelAnimationFrame(initialSeedFrame);
			}
		};
	}, [openTab, surface]);
	useHostBackButtonSync(canGoBack, goBack);
	// Session cards in a main thread open their session through this.
	useOpenConversationEvents(openTab);
	// Folder projects move onto the node's Projects app, threads included.
	useFolderProjectMigration();
	const { apps } = useApps();
	const quickReplyRequest = useQuickReplyStore((state) => state.request);
	const openQuickReply = useQuickReplyStore((state) => state.open);
	const closeQuickReply = useQuickReplyStore((state) => state.close);
	const submitQuickReply = useQuickReplyStore((state) => state.submit);
	const [quickPreviewConversationId, setQuickPreviewConversationId] = useState<
		string | null
	>(null);
	const quickPreviewConversation = quickPreviewConversationId
		? conversations.find((item) => item.id === quickPreviewConversationId)
		: undefined;
	const unreadIds = useConversationFlagsStore((state) => state.unreadIds);
	const markRead = useConversationFlagsStore((state) => state.markRead);
	const markUnread = useConversationFlagsStore((state) => state.markUnread);

	const handleOpenQuickPreview = useCallback((conversationId: string) => {
		setQuickPreviewConversationId(conversationId);
	}, []);

	const handleOpenQuickReply = useCallback(
		(conversationId: string) => {
			const conversation = conversations.find(
				(item) => item.id === conversationId
			);
			openQuickReply({
				conversationId,
				targetUrl: activeNode.url,
				title: conversation?.title ?? "Chat",
			});
		},
		[activeNode.url, conversations, openQuickReply]
	);

	const handleSubmitQuickReply = useCallback(
		(content: string) => {
			const request = useQuickReplyStore.getState().request;
			if (!request) {
				return;
			}
			// Ensure a ChatPage owns the target even when the conversation was not already
			// open. Its registration drains this request after the tab mounts.
			openTab("/chat", {
				conversationId: request.conversationId,
				title: request.title,
			});
			submitQuickReply(request.targetUrl, request.conversationId, content);
			closeQuickReply();
		},
		[closeQuickReply, openTab, submitQuickReply]
	);

	// Clips' native bare-modifier listener only signals intent. Fetching recent
	// activity stays in the desktop renderer so the existing authenticated Clips
	// client and the normal chat attachment seed remain the single data path.
	const clipsQuickAttachBusy = useRef(false);
	const activeTabRef = useRef<Tab | undefined>(undefined);
	activeTabRef.current = tabs.find((tab) => tab.id === activeTabId);
	useEffect(() => {
		const unlisteners: (() => void)[] = [];
		let disposed = false;
		listenWhenReady("clips:quick-attach", async () => {
			if (
				disposed ||
				clipsQuickAttachBusy.current ||
				!apps.some((app) => app.id === "@ryu/clips" && app.enabled)
			) {
				return;
			}
			clipsQuickAttachBusy.current = true;
			try {
				const activeTab = activeTabRef.current;
				const status = await invokeWhenReady<unknown>(
					"clips_quick_attach_status"
				);
				const destination = clipsQuickAttachDestinationFromStatus(status);
				if (!destination) {
					throw new Error("Clips destination settings are unavailable.");
				}
				const target = resolveClipsQuickAttachTarget(
					destination,
					Boolean(activeTab && isChatRoute(activeTab.path))
				);
				if (target === "missing_current_chat") {
					throw new Error(
						"Open a chat before using the Current chat destination."
					);
				}
				if (target === "current_chat" && !activeTab) {
					throw new Error("The current chat is unavailable.");
				}
				const [bundle, currentContext] = await Promise.all([
					fetchRecentActivity(toTarget(activeNode), 3),
					getCurrentContext(),
				]);
				const images: AttachedImage[] = bundle.frames.map((frame, index) => ({
					filename: `recent-activity-${frame.atMs}.jpg`,
					id: `clips-quick-attach-${Date.now()}-${index}`,
					mimeType: "image/jpeg",
					url: frame.dataUrl,
				}));
				const prompt = buildClipsQuickAttachPrompt(bundle, currentContext);
				if (images.length === 0 && !prompt) {
					throw new Error("No recent Clips activity was captured.");
				}
				if (target === "current_chat" && activeTab) {
					window.dispatchEvent(
						new CustomEvent(CLIPS_QUICK_ATTACH_EVENT, {
							detail: {
								images,
								prompt,
								tabId: activeTab.id,
							},
						})
					);
				} else {
					openTab("/chat", {
						forceNew: true,
						initialImages: images.length > 0 ? images : undefined,
						initialPrompt: prompt,
						title: "Clips context",
					});
				}
				await invokeWhenReady("clips_quick_attach_focus");
				toast.success({
					title: "Clips activity attached",
					description:
						target === "current_chat"
							? "Added to the current chat draft."
							: "A new chat is ready for your question.",
				});
			} catch (error) {
				toast.error({
					title: "Couldn't attach Clips activity",
					description:
						error instanceof Error ? error.message : "Clips is unavailable.",
				});
			} finally {
				clipsQuickAttachBusy.current = false;
			}
		})
			.then((unlisten) => {
				if (disposed) {
					unlisten();
				} else {
					unlisteners.push(unlisten);
				}
			})
			.catch(() => undefined);
		return () => {
			disposed = true;
			for (const unlisten of unlisteners) {
				unlisten();
			}
		};
	}, [activeNode, apps, openTab]);
	const { actions: titleBarActions } = useTitleBarContext();
	const { dispatch: dispatchWorkbench, state: workbenchState } =
		useDesktopWorkbench();
	// Navigation is a workbench item. In Left (the default) AppSidebar renders
	// it; moved to another pane, the same SidebarPanelContent renders as that
	// pane's Navigation tab and the docked sidebar stands down. Phones keep the
	// sidebar Sheet regardless.
	const navigationItemId = workbenchState.items.find(
		(item) => item.source.kind === "navigation"
	)?.id;
	const navigationGroup = workbenchState.groups.find(
		(group) =>
			navigationItemId !== undefined && group.itemIds.includes(navigationItemId)
	);
	const navigationMoved =
		!(isMobile || osProduct) &&
		navigationGroup !== undefined &&
		navigationGroup.region !== "left";
	const navigationShown = navigationMoved
		? navigationGroup.region === "center" ||
			(workbenchState.openRegions[navigationGroup.region] &&
				navigationGroup.activeItemId === navigationItemId)
		: sidebarShown;
	const toggleNavigation = () => {
		if (!(navigationMoved && navigationItemId)) {
			toggleSidebar();
			return;
		}
		if (navigationShown && navigationGroup.region !== "center") {
			dispatchWorkbench({
				type: "region/hide",
				region: navigationGroup.region,
			});
		} else {
			dispatchWorkbench({ type: "item/activate", itemId: navigationItemId });
		}
	};
	// While Navigation lives in another pane the docked sidebar is not rendered,
	// so its state stays collapsed: the title bar then reserves room for the
	// window's nav cluster exactly as it does for a collapsed sidebar. Returning
	// Navigation to Left shows the docked sidebar again.
	const navigationWasMoved = useRef(navigationMoved);
	useEffect(() => {
		if (navigationMoved && open) {
			setOpen(false);
		} else if (navigationWasMoved.current && !navigationMoved) {
			setOpen(true);
		}
		navigationWasMoved.current = navigationMoved;
	}, [navigationMoved, open, setOpen]);
	const workbenchDockBridge = useWorkbenchDockBridgeValue();
	const toggleWorkbenchRegion = (region: "bottom" | "right") => {
		// Only the workbench frame shows these panes (not the scroll/canvas
		// layouts or the OS canvas).
		if (!(osProduct || alternateTabView)) {
			workbenchDockBridge?.toggleRegion(region);
		}
	};
	useEffect(() => {
		const add = (event: Event) => {
			// SAFETY: WorkbenchRegion publishes ryu:workbench-add with the native group
			// id and region; DOM EventListener erases its detail. Only the id is observed.
			const detail = (event as CustomEvent<{ groupId: string }>).detail;
			if (
				!(
					detail &&
					workbenchState.groups.some((group) => group.id === detail.groupId)
				)
			) {
				return;
			}
			const tabId = openTab("/chat", { forceNew: true });
			dispatchWorkbench({
				type: "item/move",
				itemId: tabId,
				toGroupId: detail.groupId,
			});
		};
		window.addEventListener("ryu:workbench-add", add);
		return () => window.removeEventListener("ryu:workbench-add", add);
	}, [dispatchWorkbench, openTab, workbenchState.groups]);
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
	const [floatOpen, setFloatOpen] = useState(false);
	const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// In vertical-tabs mode the open tabs live in the sidebar, so the strip is
	// hidden. Reveal the docked sidebar the moment the user switches TO vertical
	// (only on that transition, so they can still close it afterward) — otherwise
	// toggling the mode with a closed sidebar would make the tabs seem to vanish.
	const prevLayoutRef = useRef(tabLayout);
	useEffect(() => {
		if (prevLayoutRef.current !== "vertical" && tabLayout === "vertical") {
			setOpen(true);
		}
		prevLayoutRef.current = tabLayout;
	}, [tabLayout, setOpen]);

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

	// Record the focused tab's route for the crash screen's "Copy console" action.
	// CrashBoundary is outside the tabs context, so it reads this via the
	// crash-context singleton (see apps/desktop/src/lib/crash-context.ts).
	const activeTab = tabs.find((t) => t.id === activeTabId);
	useEffect(() => {
		setCrashRoute(
			activeTab ? { path: activeTab.path, title: activeTab.title } : null
		);
		// The two fields, not the tab object: `tabs.find(...)` churns whenever the
		// tabs array is rebuilt, which would re-stamp the crash route on every
		// unrelated tab-state change.
	}, [activeTab?.path, activeTab?.title]);

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

	const resizingRef = useRef(false);
	const startXRef = useRef(0);
	const startWidthRef = useRef(sidebarWidth);
	const widthRef = useRef(sidebarWidth);
	const pointerIdRef = useRef<number | null>(null);
	// Position history for the release velocity — see `endRailDrag`.
	const railVelocityRef = useRef(createVelocityTracker());

	// POINTER events, not mouse events. The rail used to listen for
	// `mousemove`/`mouseup`, which a pen or a touch drag never fires — the
	// sidebar simply could not be resized by either. `setPointerCapture` then
	// keeps the drag alive when the pointer leaves the 2px handle, which is what
	// the document-level listener was standing in for.
	const handleRailPointerDown = useCallback(
		(e: React.PointerEvent) => {
			e.preventDefault();
			e.stopPropagation();
			// Capture on the handle: every subsequent move/up for this pointer is
			// retargeted here and still bubbles to the document listeners below.
			e.currentTarget.setPointerCapture?.(e.pointerId);
			pointerIdRef.current = e.pointerId;
			resizingRef.current = true;
			startXRef.current = e.clientX;
			startWidthRef.current = sidebarWidth;
			widthRef.current = sidebarWidth;
			railVelocityRef.current.reset();
			railVelocityRef.current.sample(e.clientX, e.timeStamp);
			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
		},
		[sidebarWidth]
	);

	useEffect(() => {
		const finishDrag = () => {
			resizingRef.current = false;
			pointerIdRef.current = null;
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};

		const onMove = (e: PointerEvent) => {
			if (!resizingRef.current || e.pointerId !== pointerIdRef.current) {
				return;
			}
			railVelocityRef.current.sample(e.clientX, e.timeStamp);
			const raw = startWidthRef.current + (e.clientX - startXRef.current);
			// Give at the limits instead of stopping dead. The overshoot is
			// transient — `endRailDrag` snaps back to the hard bounds on release,
			// so nothing out of range is ever the resting value.
			const next = clampWithRubberband(
				raw,
				SIDEBAR_MIN_WIDTH,
				SIDEBAR_MAX_WIDTH,
				window.innerWidth
			);
			widthRef.current = next;
			onSidebarWidthChange(next);
		};

		const onUp = (e: PointerEvent) => {
			if (!resizingRef.current || e.pointerId !== pointerIdRef.current) {
				return;
			}
			railVelocityRef.current.sample(e.clientX, e.timeStamp);
			// Where the gesture was HEADED, not where the pointer happened to stop.
			// A decisive inward flick collapses the sidebar even if the finger
			// lifted well short of the edge; a slow drag to the same pixel does
			// not. Without this the release velocity is simply discarded and both
			// gestures produce the same result.
			const projected = projectEndpoint(
				widthRef.current,
				railVelocityRef.current.velocity()
			);
			finishDrag();
			if (projected < SIDEBAR_COLLAPSE_PROJECTION) {
				// Restore the pre-drag width so reopening does not come back pinned
				// to the minimum.
				onSidebarWidthChange(startWidthRef.current);
				// Same frame as the collapse, not after it — the feedback has to
				// coincide with the event that caused it to read as one thing.
				haptic("snap");
				setOpen(false);
				return;
			}
			onSidebarWidthChange(
				Math.max(
					SIDEBAR_MIN_WIDTH,
					Math.min(SIDEBAR_MAX_WIDTH, widthRef.current)
				)
			);
		};

		// A cancelled pointer (OS gesture, focus loss) never sends `pointerup`;
		// without this the body keeps `col-resize` and `user-select: none`.
		const onCancel = (e: PointerEvent) => {
			if (e.pointerId !== pointerIdRef.current) {
				return;
			}
			finishDrag();
			onSidebarWidthChange(
				Math.max(
					SIDEBAR_MIN_WIDTH,
					Math.min(SIDEBAR_MAX_WIDTH, widthRef.current)
				)
			);
		};

		document.addEventListener("pointermove", onMove, { passive: true });
		document.addEventListener("pointerup", onUp);
		document.addEventListener("pointercancel", onCancel);
		return () => {
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
			document.removeEventListener("pointercancel", onCancel);
		};
	}, [onSidebarWidthChange, setOpen]);

	// Close floating sidebar when the docked one opens
	useEffect(() => {
		if (open) {
			if (hideTimer.current) {
				clearTimeout(hideTimer.current);
			}
			setFloatOpen(false);
		}
	}, [open]);

	const showFloat = () => {
		if (hideTimer.current) {
			clearTimeout(hideTimer.current);
			hideTimer.current = null;
		}
		setFloatOpen(true);
	};

	const scheduleHide = () => {
		// Dragging the floating panel's resize handle pulls the cursor out of the
		// panel, firing onMouseLeave. Don't hide while a resize is in progress —
		// otherwise the panel slides away mid-drag.
		if (resizingRef.current) {
			return;
		}
		if (hideTimer.current) {
			clearTimeout(hideTimer.current);
		}
		hideTimer.current = setTimeout(() => {
			// The footer trays (Downloads, Inbox) are portaled to the body — they
			// are wider than the sidebar, and this panel clips them — so moving the
			// pointer onto an open tray reads as leaving the panel. Hold the panel
			// up while one is open and re-check, so it slides away on the tick after
			// the tray closes instead of vanishing out from under it.
			if (document.querySelector('[data-sidebar-overlay="open"]')) {
				scheduleHide();
				return;
			}
			setFloatOpen(false);
		}, 200);
	};

	const handleNewConversation = useCallback(() => {
		const id = `conv-${Date.now()}`;
		// Born under whatever project is open, so the sidebar nests it right away.
		// Read at call time (not subscribed) — this handler is a one-shot action,
		// and the value that matters is the folder as it is when the user asks.
		createConversation(id, {
			folderPath: useWorkspaceStore.getState().folder ?? undefined,
		});
		setActiveConversationId(id);
		openTab("/chat", { forceNew: true, conversationId: id, title: "New chat" });
	}, [createConversation, openTab, setActiveConversationId]);

	const handleSelectConversation = useCallback(
		(id: string) => {
			setActiveConversationId(id);
			openTab("/chat", { conversationId: id });
		},
		[openTab, setActiveConversationId]
	);

	const handleDeleteConversation = useCallback(
		(id: string) => {
			void deleteConversation(id).then((deleted) => {
				if (deleted && activeConversationId === id) {
					setActiveConversationId(null);
				}
			});
		},
		[activeConversationId, deleteConversation, setActiveConversationId]
	);

	// App-level shortcuts whose handlers live here (sidebar, settings, new chat,
	// route jumps). Everything routes through the unified hotkey registry, so all
	// of these are rebindable in Settings → Keyboard Shortcuts.
	const openSettings = useSettingsDialog((s) => s.openSettings);
	const openGateway = useGatewayDialog((s) => s.openGateway);
	useHotkey("sidebar.toggle", toggleNavigation);
	useHotkey("settings.open", () => {
		if (!botProduct) {
			openSettings();
		}
	});
	useHotkey("gateway.open", () => {
		if (!botProduct) {
			openGateway();
		}
	});
	useHotkey("chat.new", handleNewConversation);
	// "Go home" opens whatever path the Dashboards app declares — and does nothing
	// when no enabled app claims it, so the shortcut can't land the user on an
	// "App not enabled" card for a feature they never turned on.
	const dashboardPath = useAppShellPath(
		DASHBOARDS_PLUGIN_ID,
		DASHBOARDS_HOME_BUTTON_ID
	);
	useHotkey("nav.home", () => {
		if (botProduct) {
			return;
		}
		if (dashboardPath) {
			openTab(dashboardPath);
		}
	});
	// Same rule for the Timeline shortcut, which reaches an app-owned path
	// (`/timeline` resolves through the companion-alias catch-all): no enabled app
	// claims it → the shortcut does nothing, rather than opening a dead tab. This is
	// the AFFORDANCE tier `use-companion-alias.ts` describes.
	const timelineCompanion = useCompanionAlias("/timeline");
	useHotkey("nav.timeline", () => {
		if (botProduct) {
			return;
		}
		if (timelineCompanion) {
			openTab("/timeline");
		}
	});
	useHotkey("nav.library", () => {
		if (!botProduct) {
			openTab("/library");
		}
	});
	// Chat-owned shortcuts, bound ONCE here and dispatched to whichever chat tab
	// is focused. They cannot be registered inside ChatPage: every chat tab stays
	// mounted, and the registry keeps one handler per id (last-writer-wins), so a
	// hidden tab would end up owning Stop and abort the wrong stream. The focused
	// tab publishes its live handlers into `useChatHotkeyTargets`; reading them
	// through `getState()` inside the handler keeps this component from
	// re-rendering on every status change.
	useHotkey("chat.stop", () => {
		const { isStreaming, stop } = useChatHotkeyTargets.getState();
		// No-op unless the focused chat actually has a turn in flight, so the key
		// never interrupts something the user cannot see.
		if (isStreaming) {
			stop?.();
		}
	});
	useHotkey("chat.voice-mode", () => {
		useChatHotkeyTargets.getState().startVoiceMode?.();
	});
	// The docks are ChatPage-local state, so they arrive through the same slot as
	// Stop. A no-op when the focused surface is not a chat, which is correct: the
	// panels only exist there.
	// Layout hotkeys run the same commands as the palette's Layout group.
	const runWorkbenchCommand = (commandId: string) => {
		const command = workbenchLayoutCommands({
			dispatch: dispatchWorkbench,
			movableRegions: DESKTOP_SHELL_REGIONS,
			state: workbenchState,
		}).find((candidate) => candidate.id === commandId);
		if (command && !command.disabled) {
			command.run();
		}
	};
	useHotkey("workbench.focus-next-pane", () =>
		runWorkbenchCommand("workbench-focus-next-pane")
	);
	useHotkey("workbench.focus-previous-pane", () =>
		runWorkbenchCommand("workbench-focus-previous-pane")
	);
	useHotkey("workbench.move-tab-to-center", () =>
		runWorkbenchCommand("workbench-move-to-center")
	);
	useHotkey("workbench.move-tab-to-right", () =>
		runWorkbenchCommand("workbench-move-to-right")
	);
	useHotkey("workbench.move-tab-to-bottom", () =>
		runWorkbenchCommand("workbench-move-to-bottom")
	);
	useHotkey("workbench.equalize-center-panes", () =>
		runWorkbenchCommand("workbench-equalize-center")
	);
	useHotkey("workbench.reset-layout", () =>
		runWorkbenchCommand("workbench-reset-layout")
	);
	// A focused chat registers its own toggles (with the workbench frame they
	// drive the same panes, falling back to the chat's Context); elsewhere the
	// keys show or hide the workbench's Bottom/Right region directly.
	useHotkey("chat.toggle-bottom-panel", () => {
		const toggle = useChatHotkeyTargets.getState().toggleBottomPanel;
		if (toggle) {
			toggle();
		} else {
			toggleWorkbenchRegion("bottom");
		}
	});
	useHotkey("chat.toggle-right-panel", () => {
		const toggle = useChatHotkeyTargets.getState().toggleRightPanel;
		if (toggle) {
			toggle();
		} else {
			toggleWorkbenchRegion("right");
		}
	});
	useHotkey("chat.search", () => {
		useChatHotkeyTargets.getState().toggleSearch?.();
	});
	// The interface switcher, from the chat, the OS desktop or any interface:
	// whichever switcher menu is on screen, else the fallback dialog.
	// Handled by the always-on capture listener (interface-escape-keys.ts), not
	// the hotkey provider, so no interface can swallow the chord; the binding
	// still comes from the registry and the user's overrides.
	const canSwitchInterface = !isRyuBot() && (canSwitchToConsole || osAccess);
	const switchBinding = useOptionalHotkeyBinding("interface.switch");
	const interfaceShown = useInterfaceActive((state) => state.active);
	// The tray's Switch Interface… and Back to Default Interface items.
	useEffect(() => {
		let disposed = false;
		const unlisteners: (() => void)[] = [];
		const track = (unlisten: () => void) => {
			if (disposed) {
				unlisten();
			} else {
				unlisteners.push(unlisten);
			}
		};
		const ignore = (error: unknown) => {
			console.error("tray interface subscription failed", error);
		};
		listenWhenReady("tray-switch-interface", () => {
			if (canSwitchInterface) {
				openInterfaceSwitcher();
			}
		})
			.then(track)
			.catch(ignore);
		listenWhenReady("tray-default-interface", () => {
			backToChat(canSwitchToConsole);
		})
			.then(track)
			.catch(ignore);
		return () => {
			disposed = true;
			for (const unlisten of unlisteners) {
				unlisten();
			}
		};
	}, [canSwitchInterface, canSwitchToConsole]);
	useEffect(() => {
		configureInterfaceEscape({
			binding: switchBinding,
			enabled: canSwitchInterface,
			interfaceShown,
			onBackToChat: () => backToChat(canSwitchToConsole),
		});
	}, [canSwitchInterface, canSwitchToConsole, interfaceShown, switchBinding]);
	// The floating Ryu chat. `open("floating")` explicitly, never the bare
	// `open()`: that restores the LAST layout, and when that was `sidebar` the
	// AssistantDock renders nothing — the key would look broken.
	useHotkey("assistant.toggle", () => {
		const { mode, open, close } = useAssistantStore.getState();
		if (mode === "closed") {
			open("floating");
		} else {
			close();
		}
	});
	// allowInInput: the default binding (F11) is a bare key, which the dispatcher
	// otherwise suppresses while a field has focus — i.e. most of the time, since
	// the composer holds focus on the main surfaces.
	useHotkey(
		"window.fullscreen-toggle",
		() => {
			toggleFullscreen().catch(() => {
				toast.error("Couldn't toggle full screen in this window.");
			});
		},
		{ allowInInput: true }
	);

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
	const osWindows: OsWindow[] = showOsDesktop
		? tabs.map((tab) => ({
				content: (
					<IsActiveTabProvider isActive={tab.id === activeTabId}>
						<CurrentTabIdProvider tabId={tab.id}>
							{tab.unloaded ? null : (
								<div className="flex size-full flex-col overflow-hidden">
									<RouteOutlet onClose={() => closeTab(tab.id)} tab={tab} />
								</div>
							)}
						</CurrentTabIdProvider>
					</IsActiveTabProvider>
				),
				id: tab.id,
				path: tab.path,
				title: tab.title,
			}))
		: EMPTY_OS_WINDOWS;

	const cssVariables2: LayoutCssVariables = {
		"--desktop-inline2-left": `${sidebarWidth - 4}px`,
	};
	const cssVariables3: LayoutCssVariables = {
		"--desktop-inline3-width": `${sidebarWidth + 16}px`,
	};
	const cssVariables4: LayoutCssVariables = {
		"--desktop-inline4-width": `${sidebarWidth}px`,
		"--desktop-inline4-pointer-Events": floatOpen ? "auto" : "none",
		"--desktop-inline4-transform": floatOpen
			? "translateX(0)"
			: "translateX(calc(-100% - 12px))",
		"--desktop-inline4-opacity": floatOpen ? 1 : 0,
	};
	const cssVariables5: LayoutCssVariables = {
		"--desktop-inline7-padding-Right": `${osProduct ? 0 : assistantDockReserve}px`,
	};
	const cssVariables6: LayoutCssVariables = {
		"--ryu-titlebar-inset": titleBarClearsContent
			? sidebarVariant === "floating"
				? "calc(var(--spacing) * 20)"
				: "calc(var(--spacing) * 18)"
			: "0px",
	};
	return (
		<TabDndProvider>
			<LoginApprovalEvents />
			{/* The stock OS desktop answers Mod+K with its own App Launcher; every
			    other workspace interface relies on the app's palette. */}
			{!(botProduct || showOsDesktop) && <CommandPalette />}
			{/* One instance for every split menu that offers "Save layout as
			    preset" — a context menu unmounts on click, so it cannot host its
			    own dialog. */}
			<SaveSplitPresetDialog />
			{canSwitchInterface ? (
				<InterfaceSwitcherDialog
					canSwitchToConsole={canSwitchToConsole}
					canSwitchToOs
				/>
			) : null}
			<DeepLinkController />
			<MediaPipDock />
			{!(botProduct || osProduct) && <SupportAccessBanner />}
			<ConnectionStatusToast />
			{!osProduct && <ReconnectRetryBanner state={reconnectRetryState} />}
			{/* Mounted app-wide, not per-page: Safe Mode changes what the whole node
			    loads, and a missing app must be explained wherever the user notices
			    it is missing. */}
			{!(botProduct || osProduct) && <SafeModeBanner />}
			{/* Opt-in Settings › Git pull request automations: one watcher per main
			    window, independent of how many sidebar panels are mounted. */}
			{!(osProduct || detachedWindow) && <PullRequestAutomationWatcher />}
			{!(osProduct || navigationMoved) && (!detachedWindow || sidebarShown) && (
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
				<div
					className={cn("fixed top-0 left-0 z-50 h-full", layoutStyles.inline3)}
					style={cssVariables3}
				>
					<div
						className={cn(
							"ryu-sidebar-surface absolute top-2 bottom-2 left-2 flex flex-col overflow-hidden rounded-2xl bg-card shadow-2xl",
							layoutStyles.inline4
						)}
						data-sidebar-preview-boundary=""
						onMouseEnter={showFloat}
						onMouseLeave={scheduleHide}
						style={cssVariables4}
					>
						<SidebarPanelContent
							activeConversationId={activeConversationId}
							onDeleteConversation={handleDeleteConversation}
							onNewConversation={handleNewConversation}
							onOpenQuickPreview={handleOpenQuickPreview}
							onOpenQuickReply={handleOpenQuickReply}
							onSelectConversation={handleSelectConversation}
						/>
						<div
							className={cn(
								"absolute top-0 right-0 h-full w-1.5 cursor-col-resize opacity-0 transition-opacity hover:bg-sidebar-border hover:opacity-100",
								layoutStyles.inline5
							)}
							onPointerDown={handleRailPointerDown}
						/>
					</div>

					<div
						className={cn(
							"absolute top-0 left-0 h-full w-10",
							layoutStyles.inline6
						)}
						onMouseEnter={showFloat}
						onMouseLeave={scheduleHide}
					/>
				</div>
			)}

			<SidebarInset
				appearance={osProduct ? "os-canvas" : undefined}
				className={cn(
					cn(
						"relative flex flex-col overflow-hidden",
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
					<InterfaceSurface
						canSwitchToConsole={canSwitchToConsole}
						descriptor={activeInterface}
					/>
				) : osProduct ? (
					<OsDesktopSurfaceWithApps
						activeWindowId={activeTabId}
						canSwitchToConsole={canSwitchToConsole}
						onActivateWindow={focusTab}
						onCloseWindow={closeTab}
						onOpenApp={(app) => openTab(app.path, { title: app.label })}
						windows={osWindows}
					/>
				) : (
					<>
						{/* Tab panels fill the entire inset and scroll UNDER the frosted
				    titlebar (which is absolutely positioned on top). Each page wrapper
				    is padded down by the titlebar height so its own header clears the
				    tab strip while content reads as one continuous glass surface. */}
						{alternateTabView ? (
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
									<InfiniteTabsCanvas />
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
										const geometry = paneRect
											? paneRectStyle(paneRect)
											: undefined;
										const paneVariables: PaneCssVariables = {
											"--pane-left": geometry?.left?.toString(),
											"--pane-top": geometry?.top?.toString(),
											"--pane-width": geometry?.width?.toString(),
											"--pane-height": geometry?.height?.toString(),
										};

										const titlebarInset =
											titleBarClearsContent &&
											(paneRect ? paneNeedsTopClearance(paneRect) : true)
												? sidebarVariant === "floating"
													? 80
													: 72
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
																"flex flex-col overflow-hidden",
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
																	tab.path === "/chat" ||
																	tab.path.startsWith("/chat/")
																}
															>
																<RouteOutlet
																	onClose={() => closeTab(tab.id)}
																	tab={tab}
																/>
															</TitlebarPage>
															<PaneBadge
																actions={focused ? titleBarActions : undefined}
																activeSplit={!!activeSplit && visible}
																containerRef={contentRef}
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
						) : (
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
														<SidebarPanelContent
															activeConversationId={activeConversationId}
															onDeleteConversation={handleDeleteConversation}
															onNewConversation={handleNewConversation}
															onOpenQuickPreview={handleOpenQuickPreview}
															onOpenQuickReply={handleOpenQuickReply}
															onSelectConversation={handleSelectConversation}
														/>
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

				{/* Status banners float just below the titlebar so they never push the
				    content down or break the under-the-bar scroll. When the titlebar
				    auto-hides, sit them at the top edge instead. */}
				{!osProduct && (
					<div
						className={cn(
							"pointer-events-none absolute right-0 left-0 z-20 [&>*]:pointer-events-auto",
							titleBarClearsContent ? "top-12" : "top-0"
						)}
					>
						{canUpdateDesktopApp ? <AutoUpdater /> : null}
					</div>
				)}
			</SidebarInset>

			{/* Global "Ask Ryu" assistant: a Notion-AI-style chat that floats over or
			    docks beside any page, carrying the current page as context and able to
			    promote itself to a full `/chat` tab. Mounted only while open so its
			    `useChat` fully unmounts on close — that is what lets the "open full
			    screen" hand-off mount a `/chat` tab on the SAME conversation id without
			    two live `useChat` instances colliding on that id. The conversation
			    survives close/reopen because its id lives in the assistant store. */}
			{assistantMode === "sidebar" && <AssistantPanel />}
			{showAssistantDock && !chatPaneVisible && <AssistantDock />}
			<QuickPreview
				conversationId={quickPreviewConversationId ?? ""}
				isUnread={
					quickPreviewConversationId
						? unreadIds.has(quickPreviewConversationId)
						: false
				}
				loadMessages={loadMessages}
				onMarkRead={markRead}
				onMarkUnread={markUnread}
				onOpenChange={(open) => {
					if (!open) {
						setQuickPreviewConversationId(null);
					}
				}}
				open={quickPreviewConversationId !== null}
				title={quickPreviewConversation?.title ?? "Chat preview"}
			/>
			<QuickReplyComposer
				onClose={closeQuickReply}
				onSubmit={handleSubmitQuickReply}
				request={quickReplyRequest}
			/>
		</TabDndProvider>
	);
}

function getSavedSidebarWidth(): number {
	try {
		const v = localStorage.getItem(SIDEBAR_WIDTH_KEY);
		if (v) {
			return Math.max(
				MIN_SIDEBAR_WIDTH,
				Math.min(MAX_SIDEBAR_WIDTH, Number(v))
			);
		}
	} catch {
		// localStorage may be unavailable; fall back to the default width.
	}
	return DEFAULT_SIDEBAR_WIDTH;
}

/** A URL handoff is one-shot. Cache the first value at module scope because
    StrictMode can replay Layout's mount after its cleanup effect has already
    removed the query from history; the second TabsProvider must receive the
    same explicit tab instead of falling through to an empty startup state. */
let cachedInitialTab: InitialTab | null | undefined;

function readInitialTab(): InitialTab | undefined {
	if (cachedInitialTab !== undefined) {
		return cachedInitialTab ?? undefined;
	}
	try {
		const transfer = readTabTransfer();
		if (transfer) {
			cachedInitialTab = { ...transfer.tab, node: transfer.node, transfer };
			return cachedInitialTab;
		}
		const p = new URLSearchParams(window.location.search);
		const conversationId = p.get("open_conversation");
		if (conversationId) {
			cachedInitialTab = { path: "/chat", conversationId, title: "Chat" };
			return cachedInitialTab;
		}
		const quickMessage = p.get("quick_message");
		if (quickMessage?.trim()) {
			cachedInitialTab = {
				path: "/chat",
				initialPrompt: quickMessage,
				title: "New chat",
			};
			return cachedInitialTab;
		}
		if (p.get("window") !== "tab") {
			cachedInitialTab = null;
			return undefined;
		}
		cachedInitialTab = {
			path: p.get("path") || "/chat",
			title: p.get("title") || undefined,
			conversationId: p.get("conv") || undefined,
			node: p.get("node") || undefined,
		};
		return cachedInitialTab;
	} catch {
		cachedInitialTab = null;
		return undefined;
	}
}

export default function Layout() {
	const { nativeWindowChrome } = useAppSurface();
	const availability = useUserAvailability();
	// Core decides whether agent questions block, so it needs the heartbeat.
	usePresenceSync();
	const location = useLocation();
	const botProduct = useProductMode() === "bot";
	const appRouteInitialTab =
		location.pathname.startsWith("/plugin/") ||
		location.pathname.startsWith("/plugin-view/")
			? { path: location.pathname }
			: undefined;
	const workbenchFolderRef = useRef(useWorkspaceStore.getState().folder);
	const workbenchSidebarOpenRef = useRef(readSidebarOpenPreference());
	const initialTabRef = useRef(
		readInitialTab() ??
			(botProduct
				? { path: "/chat", title: "New chat" }
				: (appRouteInitialTab ?? onboardingInitialTab(location.state)))
	);
	// Browser extension popup Recents reuse the dashboard URL and carry the
	// selected conversation in a one-shot query parameter. Seed the initial chat
	// tab above, then remove the parameter so refreshes cannot replay navigation.
	useEffect(() => {
		const url = new URL(window.location.href);
		if (
			!(
				url.searchParams.has("open_conversation") ||
				url.searchParams.has("quick_message")
			)
		) {
			return;
		}
		url.searchParams.delete("open_conversation");
		url.searchParams.delete("quick_message");
		window.history.replaceState(window.history.state, "", url);
	}, []);
	const [sidebarWidth, setSidebarWidth] = useState(getSavedSidebarWidth);
	const handleSidebarWidthChange = useCallback((w: number) => {
		setSidebarWidth(w);
		try {
			localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
		} catch {
			// Persisting the width is best-effort; ignore storage failures.
		}
	}, []);

	useEffect(() => {
		const handler = (e: Event) => {
			// SAFETY: setSidebarWidthSetting publishes ryu:sidebar-width with its numeric
			// Math.min/Math.max result; DOM EventListener erases the numeric detail type.
			setSidebarWidth((e as CustomEvent<number>).detail);
		};
		window.addEventListener("ryu:sidebar-width", handler);
		return () => window.removeEventListener("ryu:sidebar-width", handler);
	}, []);

	const cssVariables7: LayoutCssVariables = {
		"--sidebar-width": `${sidebarWidth}px`,
	};
	return (
		<AgentAvailabilityProvider status={availability.status}>
			<TooltipProvider delay={0}>
				<ChatDisplayPrefs>
					<DesktopWorkbenchProvider
						folder={workbenchFolderRef.current}
						sidebarOpen={workbenchSidebarOpenRef.current}
					>
						<TabsProvider initialTab={initialTabRef.current}>
							<SkillDistributionProvider>
								<TitleBarProvider>
									<SidebarProvider
										defaultOpen={!isDetachedTabWindow()}
										style={cssVariables7}
									>
										<ChatHistoryProvider>
											<SpacesProvider>
												<SystemStatusProvider>
													<HotkeysProvider
														registry={DESKTOP_HOTKEYS}
														storage={coreKvHotkeyStorage}
													>
														<DesktopReportHost>
															<ProjectDockHost>
																<PluginAvatarContributions>
																	<WorkbenchToolsProvider>
																		<LayoutContent
																			nativeWindowChrome={nativeWindowChrome}
																			onSidebarWidthChange={
																				handleSidebarWidthChange
																			}
																			sidebarWidth={sidebarWidth}
																		/>
																	</WorkbenchToolsProvider>
																</PluginAvatarContributions>
															</ProjectDockHost>
														</DesktopReportHost>
													</HotkeysProvider>
												</SystemStatusProvider>
											</SpacesProvider>
										</ChatHistoryProvider>
									</SidebarProvider>
								</TitleBarProvider>
							</SkillDistributionProvider>
						</TabsProvider>
					</DesktopWorkbenchProvider>
				</ChatDisplayPrefs>
			</TooltipProvider>
		</AgentAvailabilityProvider>
	);
}

interface LayoutCssVariables extends LayoutCSSProperties {
	"--desktop-inline1-opacity"?: string | number;
	"--desktop-inline2-left"?: string | number;
	"--desktop-inline3-width"?: string | number;
	"--desktop-inline4-opacity"?: string | number;
	"--desktop-inline4-pointer-Events"?: string | number;
	"--desktop-inline4-transform"?: string | number;
	"--desktop-inline4-width"?: string | number;
	"--desktop-inline7-padding-Right"?: string | number;
}
