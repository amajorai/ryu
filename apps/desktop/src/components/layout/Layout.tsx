import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { HotkeysProvider, useHotkey } from "@ryu/hotkeys/react";
import { Button } from "@ryu/ui/components/button";
import {
	SidebarInset,
	SidebarProvider,
	useSidebar,
} from "@ryu/ui/components/sidebar";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatDisplayPrefs } from "@/src/components/chat/ChatDisplayPrefsProvider.tsx";
import { DeepLinkController } from "@/src/components/deeplink/DeepLinkController.tsx";
import { EmptyTabsState } from "@/src/components/layout/EmptyTabsState.tsx";
import { PrivacyDisclosure } from "@/src/components/settings/privacy-disclosure.tsx";
import { SupportAccessBanner } from "@/src/components/settings/support-access-banner.tsx";
import { NodeUnreachableBanner } from "@/src/components/shell/NodeUnreachableBanner.tsx";
import { AutoUpdater } from "@/src/components/updater/AutoUpdater.tsx";
import {
	ChatHistoryProvider,
	useChatHistoryContext,
} from "@/src/contexts/ChatHistoryContext.tsx";
import { SpacesProvider } from "@/src/contexts/SpacesContext.tsx";
import { SystemStatusProvider } from "@/src/contexts/SystemStatusContext.tsx";
import type { InitialTab } from "@/src/contexts/TabsContext.tsx";
import {
	CurrentTabIdProvider,
	findSplit,
	IsActiveTabProvider,
	splitMembers,
	TabsProvider,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import { TitleBarProvider } from "@/src/contexts/TitleBarContext.tsx";
import { seedBuiltinRoutes } from "@/src/contributions/builtins.ts";
import { RouteOutlet } from "@/src/contributions/RouteOutlet.tsx";
import { useApprovalEvents } from "@/src/hooks/useApprovalEvents.ts";
import { useDesktopNotificationsStream } from "@/src/hooks/useDesktopNotificationsStream.ts";
import { useDownloadsStream } from "@/src/hooks/useDownloadsStream.ts";
import { useEditorUploader } from "@/src/hooks/useEditorUploader.ts";
import { useMeetingStream } from "@/src/hooks/useMeetingStream.ts";
import { useMonitorAlertsStream } from "@/src/hooks/useMonitorAlertsStream.ts";
import { useNotificationEvents } from "@/src/hooks/useNotificationEvents.ts";
import {
	usePluginContributionRoutes,
	usePluginContributionsLiveRefresh,
} from "@/src/hooks/usePluginContributions.ts";
import { useQuestEvents } from "@/src/hooks/useQuestEvents.ts";
import { useRegisterEditorAi } from "@/src/hooks/useRegisterEditorAi.ts";
import { useTabLayout } from "@/src/hooks/useTabLayout.ts";
import {
	DEFAULT_SIDEBAR_WIDTH,
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	SIDEBAR_WIDTH_KEY,
} from "@/src/hooks/useThemePreset.ts";
import { setCrashRoute } from "@/src/lib/crash-context.ts";
import { DESKTOP_HOTKEYS } from "@/src/lib/hotkeys/actions.ts";
import { coreKvHotkeyStorage } from "@/src/lib/hotkeys/storage.ts";
import { useAssistantStore } from "@/src/store/useAssistantStore.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { AssistantDock } from "../assistant/AssistantDock.tsx";
import { AssistantPanel } from "../assistant/AssistantPanel.tsx";
import {
	IconSidebarClosed,
	IconSidebarOpen,
} from "../icons/SidebarToggleIcon.tsx";
import { AppSidebar, SidebarPanelContent } from "./AppSidebar.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import {
	paneNeedsTopClearance,
	paneStyle,
	SplitGutters,
} from "./SplitView.tsx";
import { TitleBar } from "./TitleBar.tsx";
import { pathScrollsUnderTitlebar } from "./titlebarScroll.ts";

// Populate the contribution registry with every built-in route BEFORE first
// render, so `RouteOutlet` (which resolves a tab's path through the registry)
// can render built-in tabs. Idempotent — safe to call at module load.
seedBuiltinRoutes();

const isMac = navigator.userAgent.includes("Mac");

interface LayoutContentProps {
	onSidebarWidthChange: (w: number) => void;
	sidebarWidth: number;
}

function LayoutContent({
	sidebarWidth,
	onSidebarWidthChange,
}: LayoutContentProps) {
	const {
		activeConversationId,
		setActiveConversationId,
		deleteConversation,
		createConversation,
	} = useChatHistoryContext();

	// One app-wide subscription to Core's download SSE stream → downloads store,
	// powering the global DownloadCenter overlay below.
	useDownloadsStream();

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
	// toast + native OS notification from built-in agent actions (notify__desktop).
	useDesktopNotificationsStream();

	// App-wide subscription to Core's per-user notification SSE stream → toast +
	// OS notification for user-targeted pings (notify_user workflow node) and a
	// live Inbox feed. Distinct from the broadcast stream above (Core filters
	// user-targeted pings out of /api/events/all), so the two never double-toast.
	useNotificationEvents();

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

	// Live refresh for the contributions cache: Core broadcasts on the
	// `system:plugins` realtime room after every plugin enable/disable/grants
	// change; this invalidates the shared react-query read immediately. Remote
	// nodes fail-soft to the stale-window poll above.
	usePluginContributionsLiveRefresh();

	const { open, setOpen, toggleSidebar } = useSidebar();
	// Reserve room on the right when the "Ask Ryu" assistant is docked as a
	// sidebar, so the page content slides in beside it rather than under it.
	const assistantMode = useAssistantStore((s) => s.mode);
	const {
		tabs,
		splits,
		activeTabId,
		openTab,
		closeTab,
		focusTab,
		goBack,
		goForward,
		canGoBack,
		canGoForward,
	} = useTabsContext();
	const tabLayout = useTabLayout();
	const [floatOpen, setFloatOpen] = useState(false);
	const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// The positioned content area; SplitGutters measures it to translate drag
	// pixels into pane fractions.
	const contentRef = useRef<HTMLDivElement>(null);

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

	// The split (if any) the focused tab belongs to, and the ordered ids of the
	// panes to show (split members in tab order). With no split, only the focused
	// tab is shown — exactly as before. Every other tab stays mounted but hidden
	// so its state survives.
	const activeSplit = findSplit(tabs, splits, activeTabId);
	let paneIds: string[] = [];
	if (activeSplit) {
		paneIds = splitMembers(tabs, activeSplit.id).map((t) => t.id);
	} else if (activeTabId) {
		paneIds = [activeTabId];
	}

	// Record the focused tab's route for the crash screen's "Copy console" action.
	// CrashBoundary is outside the tabs context, so it reads this via the
	// crash-context singleton (see apps/desktop/src/lib/crash-context.ts).
	const activeTab = tabs.find((t) => t.id === activeTabId);
	useEffect(() => {
		setCrashRoute(
			activeTab ? { path: activeTab.path, title: activeTab.title } : null
		);
	}, [activeTab]);

	// The floating "Ask Ryu" dock would just overlap a full chat surface, so hide
	// it whenever a `/chat` pane is currently visible (in a split, any visible
	// pane being chat is enough for the overlap). Chat pages already *are* the
	// assistant, so the dock is redundant there.
	const chatPaneVisible = paneIds.some(
		(id) => tabs.find((t) => t.id === id)?.path.startsWith("/chat") ?? false
	);

	// TEMP: floating Ryu (Ask Ryu dock) disabled per request. Flip to `true` to
	// restore the launcher.
	const showAssistantDock = false;

	const resizingRef = useRef(false);
	const startXRef = useRef(0);
	const startWidthRef = useRef(sidebarWidth);

	const handleRailMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			resizingRef.current = true;
			startXRef.current = e.clientX;
			startWidthRef.current = sidebarWidth;
			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
		},
		[sidebarWidth]
	);

	useEffect(() => {
		const onMove = (e: MouseEvent) => {
			if (!resizingRef.current) {
				return;
			}
			const next = startWidthRef.current + (e.clientX - startXRef.current);
			onSidebarWidthChange(Math.max(180, Math.min(480, next)));
		};
		const onUp = () => {
			if (!resizingRef.current) {
				return;
			}
			resizingRef.current = false;
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};
		document.addEventListener("mousemove", onMove, { passive: true });
		document.addEventListener("mouseup", onUp);
		return () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
		};
	}, [onSidebarWidthChange]);

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
		hideTimer.current = setTimeout(() => setFloatOpen(false), 200);
	};

	const handleNewConversation = () => {
		const id = `conv-${Date.now()}`;
		createConversation(id);
		setActiveConversationId(id);
		openTab("/chat", { forceNew: true, conversationId: id, title: "New chat" });
	};

	const handleSelectConversation = (id: string) => {
		setActiveConversationId(id);
		openTab("/chat", { conversationId: id });
	};

	const handleDeleteConversation = (id: string) => {
		deleteConversation(id);
		if (activeConversationId === id) {
			setActiveConversationId(null);
		}
	};

	// App-level shortcuts whose handlers live here (sidebar, settings, new chat,
	// route jumps). Everything routes through the unified hotkey registry, so all
	// of these are rebindable in Settings → Keyboard Shortcuts.
	const openSettings = useSettingsDialog((s) => s.openSettings);
	useHotkey("sidebar.toggle", toggleSidebar);
	useHotkey("settings.open", () => openSettings());
	useHotkey("chat.new", handleNewConversation);
	useHotkey("nav.home", () => openTab("/home"));
	useHotkey("nav.timeline", () => openTab("/timeline"));
	useHotkey("nav.library", () => openTab("/library"));

	return (
		<>
			<CommandPalette />
			<DeepLinkController />
			<PrivacyDisclosure />
			<SupportAccessBanner />
			<AppSidebar
				activeConversationId={activeConversationId}
				onDeleteConversation={handleDeleteConversation}
				onNewConversation={handleNewConversation}
				onSelectConversation={handleSelectConversation}
			/>

			{/* Pinned navigation cluster (back / forward / sidebar toggle) at the
			    window's top-left. Fixed so it stays put whether the sidebar is docked
			    or collapsed, and out of the tab strip entirely. On macOS it sits just
			    right of the traffic lights; on Windows it uses the same 16px inset as
			    top-4 so the cluster clears the window edge and lines up with the
			    sidebar card's inner padding. */}
			<div
				className={cn(
					"fixed z-[60] flex flex-row items-center gap-1",
					"top-4",
					isMac ? "left-24" : "left-6"
				)}
				data-tauri-drag-region={false}
			>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								aria-label="Go back"
								className="size-8"
								disabled={!canGoBack}
								onClick={goBack}
								size="icon"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
							</Button>
						}
					/>
					<TooltipContent>Go back</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								aria-label="Go forward"
								className="size-8"
								disabled={!canGoForward}
								onClick={goForward}
								size="icon"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={ArrowRight01Icon} />
							</Button>
						}
					/>
					<TooltipContent>Go forward</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								aria-label="Toggle sidebar"
								className="size-8"
								onClick={toggleSidebar}
								size="icon"
								variant="ghost"
							>
								{open ? (
									<IconSidebarOpen className="size-4" />
								) : (
									<IconSidebarClosed className="size-4" />
								)}
							</Button>
						}
					/>
					<TooltipContent>
						{open ? "Hide sidebar" : "Show sidebar"}
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								aria-label="Search"
								className="size-8"
								onClick={() =>
									window.dispatchEvent(
										new CustomEvent("ryu:open-command-palette")
									)
								}
								size="icon"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={Search01Icon} />
							</Button>
						}
					/>
					<TooltipContent>Search {isMac ? "⌘K" : "Ctrl K"}</TooltipContent>
				</Tooltip>
			</div>

			{/* Resize handle for the docked sidebar */}
			{open && (
				// biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions: sidebar resize handle
				<div
					className="fixed top-0 z-20 h-full w-2 cursor-col-resize opacity-0 transition-opacity hover:bg-sidebar-border hover:opacity-100"
					onMouseDown={handleRailMouseDown}
					style={{ left: `${sidebarWidth - 4}px` }}
				/>
			)}

			{/* Left-edge hover zone for floating sidebar */}
			{!open && (
				<div
					className="fixed top-0 left-0 z-50 h-full"
					style={{ pointerEvents: "none", width: `${sidebarWidth + 16}px` }}
				>
					<div
						className="ryu-sidebar-surface absolute top-2 bottom-2 left-2 flex flex-col overflow-hidden rounded-2xl bg-card shadow-2xl"
						onMouseEnter={showFloat}
						onMouseLeave={scheduleHide}
						style={{
							width: `${sidebarWidth}px`,
							pointerEvents: floatOpen ? "auto" : "none",
							transform: floatOpen
								? "translateX(0)"
								: "translateX(calc(-100% - 12px))",
							opacity: floatOpen ? 1 : 0,
							transition:
								"transform 280ms cubic-bezier(0.34,1.2,0.64,1), opacity 240ms ease-out",
						}}
					>
						<SidebarPanelContent
							activeConversationId={activeConversationId}
							onDeleteConversation={handleDeleteConversation}
							onNewConversation={handleNewConversation}
							onSelectConversation={handleSelectConversation}
						/>
						<div
							className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize opacity-0 transition-opacity hover:bg-sidebar-border hover:opacity-100"
							onMouseDown={handleRailMouseDown}
						/>
					</div>

					<div
						className="absolute top-0 left-0 h-full w-10"
						onMouseEnter={showFloat}
						onMouseLeave={scheduleHide}
						style={{ pointerEvents: "auto" }}
					/>
				</div>
			)}

			<SidebarInset
				className="relative flex flex-col overflow-hidden transition-[padding] duration-300 ease-out"
				style={{
					// Reserves room for the docked assistant's inset floating card
					// (380px wide + 8px right inset) so page content sits beside it
					// rather than under it.
					paddingRight: assistantMode === "sidebar" ? 388 : undefined,
				}}
			>
				{/* Tab panels fill the entire inset and scroll UNDER the frosted
				    titlebar (which is absolutely positioned on top). Each page wrapper
				    is padded down by the titlebar height so its own header clears the
				    tab strip while content reads as one continuous glass surface. */}
				<div
					className="relative min-h-0 flex-1 overflow-hidden"
					ref={contentRef}
				>
					{tabs.length === 0 ? (
						<EmptyTabsState />
					) : (
						tabs.map((tab) => {
							// `focused` drives the titlebar and the active-pane highlight; a
							// split also shows non-focused panes, which stay fully live.
							const focused = tab.id === activeTabId;
							const paneIndex = paneIds.indexOf(tab.id);
							const visible = paneIndex !== -1;
							// Panes are absolutely positioned so the tree is never reparented
							// (reparenting would unmount it and lose state). Hidden-but-mounted
							// tabs keep their timers/subscriptions; unloaded tabs are dropped
							// entirely. Active split members are exempt from unloading, so a
							// visible pane is never null.
							let style: CSSProperties;
							if (visible && activeSplit) {
								style = paneStyle(
									activeSplit.orientation,
									activeSplit.sizes,
									paneIndex
								);
							} else if (visible) {
								style = { position: "absolute", inset: 0 };
							} else {
								style = { display: "none" };
							}
							// Scroll-under panes (chat + the store / marketplace family)
							// manage their own top clearance internally so their content sits
							// UNDER the frosted titlebar. Every other page reserves the bar's
							// height so its header sits cleanly below the solid tab bar.
							const scrollsUnderTitlebar = pathScrollsUnderTitlebar(tab.path);
							const needsClearance =
								!scrollsUnderTitlebar &&
								(!activeSplit ||
									paneNeedsTopClearance(activeSplit.orientation, paneIndex));
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
													needsClearance && "pt-12",
													// In a split, ring the focused pane so it's obvious
													// which one keyboard + titlebar actions target.
													activeSplit &&
														visible &&
														focused &&
														"ring-2 ring-primary/40 ring-inset"
												)}
												// Clicking anywhere in a non-focused pane focuses it
												// (no nav-history entry) before the inner UI reacts.
												onMouseDownCapture={
													activeSplit && visible && !focused
														? () => focusTab(tab.id)
														: undefined
												}
												style={style}
											>
												<RouteOutlet
													onClose={() => closeTab(tab.id)}
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
				</div>
				{/* Frosted titlebar overlays the content (absolute, z-10). */}
				<TitleBar />

				{/* Status banners float just below the titlebar so they never push the
				    content down or break the under-the-bar scroll. */}
				<div className="pointer-events-none absolute top-12 right-0 left-0 z-20 [&>*]:pointer-events-auto">
					<AutoUpdater />
					<NodeUnreachableBanner />
				</div>
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
		</>
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

/** When this window was spawned as a tear-off ("open in new window"), the Rust
    command seeds `?window=tab&…` so the new window opens straight onto that one
    conversation/node instead of a blank chat. Read once at mount. */
function readInitialTab(): InitialTab | undefined {
	try {
		const p = new URLSearchParams(window.location.search);
		if (p.get("window") !== "tab") {
			return undefined;
		}
		return {
			path: p.get("path") || "/chat",
			title: p.get("title") || undefined,
			conversationId: p.get("conv") || undefined,
			node: p.get("node") || undefined,
		};
	} catch {
		return undefined;
	}
}

export default function Layout() {
	const initialTabRef = useRef(readInitialTab());
	const [sidebarWidth, setSidebarWidth] = useState(getSavedSidebarWidth);
	const handleSidebarWidthChange = (w: number) => {
		setSidebarWidth(w);
		try {
			localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
		} catch {
			// Persisting the width is best-effort; ignore storage failures.
		}
	};

	useEffect(() => {
		const handler = (e: Event) => {
			setSidebarWidth((e as CustomEvent<number>).detail);
		};
		window.addEventListener("ryu:sidebar-width", handler);
		return () => window.removeEventListener("ryu:sidebar-width", handler);
	}, []);

	return (
		<TooltipProvider delay={0}>
			<ChatDisplayPrefs>
				<TabsProvider initialTab={initialTabRef.current}>
					<TitleBarProvider>
						<SidebarProvider
							style={
								{
									"--sidebar-width": `${sidebarWidth}px`,
								} as React.CSSProperties
							}
						>
							<ChatHistoryProvider>
								<SpacesProvider>
									<SystemStatusProvider>
										<HotkeysProvider
											registry={DESKTOP_HOTKEYS}
											storage={coreKvHotkeyStorage}
										>
											<LayoutContent
												onSidebarWidthChange={handleSidebarWidthChange}
												sidebarWidth={sidebarWidth}
											/>
										</HotkeysProvider>
									</SystemStatusProvider>
								</SpacesProvider>
							</ChatHistoryProvider>
						</SidebarProvider>
					</TitleBarProvider>
				</TabsProvider>
			</ChatDisplayPrefs>
		</TooltipProvider>
	);
}
