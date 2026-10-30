import { AgentAvailabilityProvider } from "@ryu/blocks/desktop/agent-availability.tsx";
import { HotkeysProvider } from "@ryu/hotkeys/react";
import {
	readSidebarOpenPreference,
	SidebarProvider,
} from "@ryu/ui/components/sidebar.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { PluginAvatarContributions } from "@/src/components/avatar/PluginAvatarContributions.tsx";
import { ChatDisplayPrefs } from "@/src/components/chat/ChatDisplayPrefsProvider.tsx";
import { DesktopReportHost } from "@/src/components/marketplace/report-host.tsx";
import { ProjectDockHost } from "@/src/components/panels/ProjectDockHost.tsx";
import { SkillDistributionProvider } from "@/src/components/skills/SkillDistributionProvider.tsx";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { ChatHistoryProvider } from "@/src/contexts/ChatHistoryContext.tsx";
import { SpacesProvider } from "@/src/contexts/SpacesContext.tsx";
import { SystemStatusProvider } from "@/src/contexts/SystemStatusContext.tsx";
import type { InitialTab } from "@/src/contexts/TabsContext.tsx";
import { TabsProvider } from "@/src/contexts/TabsContext.tsx";
import { TitleBarProvider } from "@/src/contexts/TitleBarContext.tsx";
import { seedBuiltinRoutes } from "@/src/contributions/builtins.ts";
import { usePresenceSync } from "@/src/hooks/usePresenceSync.ts";
import {
	DEFAULT_SIDEBAR_WIDTH,
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	SIDEBAR_WIDTH_KEY,
} from "@/src/hooks/useThemePreset.ts";
import { useUserAvailability } from "@/src/hooks/useUserAvailability.ts";
import { DESKTOP_HOTKEYS } from "@/src/lib/hotkeys/actions.ts";
import { coreKvHotkeyStorage } from "@/src/lib/hotkeys/storage.ts";
import { onboardingInitialTab } from "@/src/lib/onboarding-navigation.ts";
import { useProductMode } from "@/src/lib/product-mode.ts";
import {
	isDetachedTabWindow,
	readTabTransfer,
} from "@/src/lib/tab-transfer.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { DesktopWorkbenchProvider } from "@/src/workbench/DesktopWorkbenchContext.tsx";
import { WorkbenchToolsProvider } from "@/src/workbench/useWorkbenchTools.tsx";
import type { LayoutCssVariables } from "../shell/layout/layout-constants.ts";
import { LayoutContent } from "../shell/layout/layout-content.tsx";

// Populate the contribution registry with every built-in route BEFORE first
// render, so `RouteOutlet` (which resolves a tab's path through the registry)
// can render built-in tabs. Idempotent — safe to call at module load.
seedBuiltinRoutes();

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
