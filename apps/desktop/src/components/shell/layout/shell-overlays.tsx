import { lazy, Suspense } from "react";
import { DeepLinkController } from "@/src/components/deeplink/DeepLinkController.tsx";
import { MediaPipDock } from "@/src/components/media/MediaPip.tsx";
import { SupportAccessBanner } from "@/src/components/settings/support-access-banner.tsx";
import { ConnectionStatusToast } from "@/src/components/shell/ConnectionStatusToast.tsx";
import { ReconnectRetryBanner } from "@/src/components/shell/ReconnectRetryBanner.tsx";
import { SafeModeBanner } from "@/src/components/shell/SafeModeBanner.tsx";
import { ShellSettingsDialog } from "@/src/components/shell/shell-settings-dialog.tsx";
import type { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import type { Tab } from "@/src/contexts/TabsContext.tsx";
import {
	CurrentTabIdProvider,
	IsActiveTabProvider,
} from "@/src/contexts/TabsContext.tsx";
import { RouteOutlet } from "@/src/contributions/RouteOutlet.tsx";
import { LoginApprovalEvents } from "@/src/hooks/useLoginApprovalEvents.tsx";
import type { useReconnectRetry } from "@/src/hooks/useReconnectRetry.ts";
import { useInterfaceSwitcher } from "@/src/interfaces/interface-switcher.ts";
import type { useAssistantStore } from "@/src/store/useAssistantStore.ts";
import { AssistantDock } from "../../assistant/AssistantDock.tsx";
import { PullRequestAutomationWatcher } from "../../layout/PullRequestAutomationWatcher.tsx";
import { SaveSplitPresetDialog } from "../../layout/SplitPresetMenu.tsx";
import type { OsWindow } from "../../os/OsDesktopSurface.tsx";
import { DeferredCommandPalette } from "../command-palette/deferred-command-palette.tsx";
import {
	EMPTY_OS_WINDOWS,
	type LayoutCssVariables,
} from "./layout-constants.ts";
import type { useQuickConversationActions } from "./use-conversation-actions.ts";

// Overlays that are closed on first paint load on first use, so the shell
// does not carry their code (and their dependency graphs) up front.
const AssistantPanel = lazy(() =>
	import("../../assistant/AssistantPanel.tsx").then((module) => ({
		default: module.AssistantPanel,
	}))
);
const InterfaceSwitcherDialog = lazy(() =>
	import("../../layout/InterfaceSwitcherDialog.tsx").then((module) => ({
		default: module.InterfaceSwitcherDialog,
	}))
);
const QuickPreview = lazy(() =>
	import("@/src/components/chat/QuickPreview.tsx").then((module) => ({
		default: module.QuickPreview,
	}))
);
const QuickReplyComposer = lazy(() =>
	import("@/src/components/chat/QuickReplyComposer.tsx").then((module) => ({
		default: module.QuickReplyComposer,
	}))
);

/** The Ask Ryu assistant surfaces plus the sidebar's Quick Preview / Reply. */
export function ConversationOverlays({
	assistantMode,
	chatPaneVisible,
	loadMessages,
	quick,
	showAssistantDock,
}: {
	assistantMode: ReturnType<typeof useAssistantStore.getState>["mode"];
	chatPaneVisible: boolean;
	loadMessages: ReturnType<typeof useChatHistoryContext>["loadMessages"];
	quick: ReturnType<typeof useQuickConversationActions>;
	showAssistantDock: boolean;
}) {
	const {
		closeQuickReply,
		handleSubmitQuickReply,
		markRead,
		markUnread,
		quickPreviewConversation,
		quickPreviewConversationId,
		quickReplyRequest,
		setQuickPreviewConversationId,
		unreadIds,
	} = quick;
	return (
		<>
			{/* Global "Ask Ryu" assistant: a Notion-AI-style chat that floats over or
			    docks beside any page, carrying the current page as context and able to
			    promote itself to a full `/chat` tab. Mounted only while open so its
			    `useChat` fully unmounts on close — that is what lets the "open full
			    screen" hand-off mount a `/chat` tab on the SAME conversation id without
			    two live `useChat` instances colliding on that id. The conversation
			    survives close/reopen because its id lives in the assistant store. */}
			<Suspense fallback={null}>
				{assistantMode === "sidebar" && <AssistantPanel />}
			</Suspense>
			{showAssistantDock && !chatPaneVisible && <AssistantDock />}
			<Suspense fallback={null}>
				{quickPreviewConversationId === null ? null : (
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
				)}
				{quickReplyRequest ? (
					<QuickReplyComposer
						onClose={closeQuickReply}
						onSubmit={handleSubmitQuickReply}
						request={quickReplyRequest}
					/>
				) : null}
			</Suspense>
		</>
	);
}

/** The interface switcher dialog, loaded the first time it opens. */
function DeferredInterfaceSwitcher({
	canSwitchToConsole,
}: {
	canSwitchToConsole: boolean;
}) {
	const open = useInterfaceSwitcher((state) => state.fallbackOpen);
	if (!open) {
		return null;
	}
	return (
		<Suspense fallback={null}>
			<InterfaceSwitcherDialog
				canSwitchToConsole={canSwitchToConsole}
				canSwitchToOs
			/>
		</Suspense>
	);
}

/** App-wide dialogs, controllers and status banners mounted once per window. */
export function ShellOverlays({
	botProduct,
	canSwitchInterface,
	canSwitchToConsole,
	detachedWindow,
	osProduct,
	showOsDesktop,
}: {
	botProduct: boolean;
	canSwitchInterface: boolean;
	canSwitchToConsole: boolean;
	detachedWindow: boolean;
	osProduct: boolean;
	showOsDesktop: boolean;
}) {
	return (
		<>
			<LoginApprovalEvents />
			{/* The window's one App Settings dialog; every surface opens it through
			    useSettingsDialog. */}
			{botProduct ? null : <ShellSettingsDialog />}
			{/* The stock OS desktop answers Mod+K with its own App Launcher; every
			    other workspace interface relies on the app's palette. */}
			{!(botProduct || showOsDesktop) && <DeferredCommandPalette />}
			{/* One instance for every split menu that offers "Save layout as
			    preset" — a context menu unmounts on click, so it cannot host its
			    own dialog. */}
			<SaveSplitPresetDialog />
			{canSwitchInterface ? (
				<DeferredInterfaceSwitcher canSwitchToConsole={canSwitchToConsole} />
			) : null}
			<DeepLinkController />
			<MediaPipDock />
			{/* The OS desktop has no header to hang the strip under, so it keeps
			    the floating toast; every other shell mounts ShellBanners. */}
			{osProduct ? <ConnectionStatusToast layout="toast" /> : null}
			{/* Opt-in Settings › Git pull request automations: one watcher per main
			    window, independent of how many sidebar panels are mounted. */}
			{!(osProduct || detachedWindow) && <PullRequestAutomationWatcher />}
		</>
	);
}

/**
 * The system banners, stacked as inline strips under the header. Mounted
 * app-wide, not per-page: Safe Mode changes what the whole node loads, and a
 * missing app must be explained wherever the user notices it is missing.
 */
export function ShellBanners({
	botProduct,
	reconnectRetryState,
}: {
	botProduct: boolean;
	reconnectRetryState: ReturnType<typeof useReconnectRetry>;
}) {
	return (
		<>
			<ConnectionStatusToast />
			<ReconnectRetryBanner state={reconnectRetryState} />
			{botProduct ? null : <SafeModeBanner />}
			{botProduct ? null : <SupportAccessBanner />}
		</>
	);
}

/** The OS desktop's window adapter over the retained tabs. */
export function buildOsWindows(
	showOsDesktop: boolean,
	tabs: Tab[],
	activeTabId: string,
	closeTab: (id: string) => void
): OsWindow[] {
	return showOsDesktop
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
}

/** The inline CSS variables LayoutContent hands its fixed and inset layers. */
export function layoutCssVariables({
	assistantDockReserve,
	floatOpen,
	osProduct,
	sidebarWidth,
	titleBarClearsContent,
}: {
	assistantDockReserve: number | undefined;
	floatOpen: boolean;
	osProduct: boolean;
	sidebarWidth: number;
	titleBarClearsContent: boolean;
}) {
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
		// Both variants now start the content at the window's top edge (the
		// flush inset no longer has the primitive's 8px card margin).
		"--ryu-titlebar-inset": titleBarClearsContent
			? "calc(var(--spacing) * 20)"
			: "0px",
	};
	return {
		cssVariables2,
		cssVariables3,
		cssVariables4,
		cssVariables5,
		cssVariables6,
	};
}
