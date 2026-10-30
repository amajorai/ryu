import { toast } from "@ryu/ui/components/sileo.tsx";
import { useEffect, useRef } from "react";
import type { AttachedImage } from "@/components/agent-elements/input-bar.tsx";
import type { AppSurfaceCapabilities } from "@/src/contexts/app-surface-context.tsx";
import type { Tab } from "@/src/contexts/TabsContext.tsx";
import { useAppShellRoutes } from "@/src/contributions/app-shell-routes.ts";
import { useAgentAmbientAudio } from "@/src/hooks/useAgentAmbientAudio.ts";
import { useApprovalEvents } from "@/src/hooks/useApprovalEvents.ts";
import type { UseAppsResult } from "@/src/hooks/useApps.ts";
import { usePluginBackgroundSync } from "@/src/hooks/useContributedBackgrounds.ts";
import { usePluginThemeSync } from "@/src/hooks/useContributedThemes.ts";
import { useCreditAlertEvents } from "@/src/hooks/useCreditAlertEvents.ts";
import { useDesktopNotificationsStream } from "@/src/hooks/useDesktopNotificationsStream.ts";
import { useDownloadsStream } from "@/src/hooks/useDownloadsStream.ts";
import { useEditorUploader } from "@/src/hooks/useEditorUploader.ts";
import { useMeetingStream } from "@/src/hooks/useMeetingStream.ts";
import { useMonitorAlertsStream } from "@/src/hooks/useMonitorAlertsStream.ts";
import { useNavigationEvents } from "@/src/hooks/useNavigationEvents.ts";
import { useNotificationEvents } from "@/src/hooks/useNotificationEvents.ts";
import {
	usePluginContributionRoutes,
	usePluginContributionsLiveRefresh,
	usePluginContributionTabIcons,
} from "@/src/hooks/usePluginContributions.ts";
import { useQuestEvents } from "@/src/hooks/useQuestEvents.ts";
import { useReconnectRetry } from "@/src/hooks/useReconnectRetry.ts";
import { useRegisterEditorAi } from "@/src/hooks/useRegisterEditorAi.ts";
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
	EXTENSION_DESKTOP_LAYOUT_READY_EVENT,
	EXTENSION_QUICK_MESSAGE_EVENT,
	extensionQuickMessageSeedFromEvent,
	extensionQuickMessageTab,
	takeExtensionQuickMessageSeed,
} from "@/src/lib/extension-quick-message.ts";
import { installRoutePrefetch } from "@/src/lib/route-prefetch.ts";
import { invokeWhenReady, listenWhenReady } from "@/src/lib/tauri-ready.ts";
import { useLiveActivities } from "@/src/live/useLiveActivities.ts";
import type { Node } from "@/src/store/useNodeStore.ts";
import type { DesktopWorkbenchValue } from "@/src/workbench/DesktopWorkbenchContext.tsx";
import type { OpenTab } from "./layout-constants.ts";

/** The app-wide stream subscriptions and registries LayoutContent mounts once. */
export function useLayoutAppSubscriptions() {
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
	return reconnectRetryState;
}

/** Opens the chat the browser extension's quick-message seed asks for. */
export function useExtensionQuickMessageSeed(
	openTab: OpenTab,
	surface: AppSurfaceCapabilities["surface"]
) {
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
}

/** The Clips bare-modifier quick-attach: recent activity into a chat draft. */
export function useClipsQuickAttach({
	activeNode,
	activeTabId,
	apps,
	openTab,
	tabs,
}: {
	activeNode: Node;
	activeTabId: string;
	apps: UseAppsResult["apps"];
	openTab: OpenTab;
	tabs: Tab[];
}) {
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
}

/** Opens a fresh chat in the workbench group whose "+" was pressed. */
export function useWorkbenchAddListener(
	workbenchState: DesktopWorkbenchValue["state"],
	dispatchWorkbench: DesktopWorkbenchValue["dispatch"],
	openTab: OpenTab
) {
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
}

export function useRevealSidebarForVerticalTabs(
	tabLayout: string,
	setOpen: (open: boolean) => void
) {
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
}

export function useCrashRouteRecorder(tabs: Tab[], activeTabId: string) {
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
}
