import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachedImage } from "@/components/agent-elements/input-bar.tsx";
import type { RewindPreselect } from "@/src/components/chat/RewindDialog.tsx";
import type { ImageEditorAsset } from "@/src/components/media/ImageEditorDialog.tsx";
import { useSystemStatusContext } from "@/src/contexts/SystemStatusContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useChatPickerPlacement } from "@/src/hooks/useChatPickerPlacement.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import {
	usePluginContributions,
	usePluginContributionsQuery,
} from "@/src/hooks/usePluginContributions.ts";
import { useProjectlessTaskFolder } from "@/src/hooks/useProjectlessTaskFolder.ts";
import { useShowBottomPanelToggle } from "@/src/hooks/useShowBottomPanelToggle.ts";
import {
	readLastUsedAgentId,
	seedComposerAgentId,
} from "@/src/lib/composer-target.ts";
import { useBrowserProviderSnapshot } from "@/src/lib/extension-host.ts";
import {
	EXPANDED_COMPOSER_FEATURE_KIND,
	EXPANDED_COMPOSER_PLUGIN_ID,
	GHOST_CHAT_FEATURE_KIND,
	GHOST_CHATS_PLUGIN_ID,
	hasPluginChatFeature,
	SIDE_CHAT_FEATURE_KIND,
	SIDE_CHATS_PLUGIN_ID,
	STATS_FEATURE_KIND,
	STATS_PLUGIN_ID,
} from "@/src/lib/plugin-chat-features.ts";
import { useProductMode } from "@/src/lib/product-mode.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import type { WorkbenchToolOption } from "@/src/workbench/workbench-chrome.tsx";
import { useWorkbenchDockBridge } from "@/src/workbench/workbench-dock-bridge.tsx";
import type { ChatPageBaseScope } from "./ChatPage.types.ts";

export type UseChatPageChromeInput = ChatPageBaseScope;

/** Connection status, plugin chat features, and the panel and dialog state ChatPage owns. */
export function useChatPageChrome({
	mergedAgentId,
	initialAgent,
	initialTeamId,
	initialProject,
}: UseChatPageChromeInput) {
	const botProduct = useProductMode() === "bot";
	// Read gateway/core reachability from the shared provider so this page and
	// the shell banner always agree on the same poll tick.
	const {
		coreReachable,
		connectionPhase,
		gatewayReachable,
		loading: statusLoading,
	} = useSystemStatusContext();
	const browserSnapshot = useBrowserProviderSnapshot();
	const browserLocalAbortRef = useRef<AbortController | null>(null);
	const forceCoreNextRef = useRef(false);
	const handleSendRef = useRef<
		(message: {
			attachments?: AttachedImage[];
			content: string;
			role: "user";
		}) => void
	>(() => undefined);
	const interfaceLevel = useInterfaceLevel();
	const [chatPickerPlacement] = useChatPickerPlacement();
	const pluginContributions = usePluginContributions();
	const drawesomeCompanion = pluginContributions.companions.find(
		(companion) => companion.pluginId === "@ryu/drawesome" && companion.hasUi
	);
	const {
		isError: pluginContributionsFailed,
		isSuccess: pluginContributionsLoaded,
	} = usePluginContributionsQuery();
	const pluginContributionsSettled =
		pluginContributionsLoaded || pluginContributionsFailed;
	const sideChatsPluginEnabled = hasPluginChatFeature(
		pluginContributions.chat_features,
		SIDE_CHATS_PLUGIN_ID,
		SIDE_CHAT_FEATURE_KIND
	);
	const ghostChatsPluginEnabled = hasPluginChatFeature(
		pluginContributions.chat_features,
		GHOST_CHATS_PLUGIN_ID,
		GHOST_CHAT_FEATURE_KIND
	);
	const expandedComposerPluginEnabled = hasPluginChatFeature(
		pluginContributions.chat_features,
		EXPANDED_COMPOSER_PLUGIN_ID,
		EXPANDED_COMPOSER_FEATURE_KIND
	);
	const statsPluginEnabled = hasPluginChatFeature(
		pluginContributions.chat_features,
		STATS_PLUGIN_ID,
		STATS_FEATURE_KIND
	);

	// Atomic selectors: a whole-store read re-rendered the page on every
	// workspace store write (recent folders, projects, worktree prefs).
	const folder = useWorkspaceStore((state) => state.folder);
	const setFolder = useWorkspaceStore((state) => state.setFolder);
	const activeNode = useActiveNode();
	const [projectlessTaskFolder] = useProjectlessTaskFolder();
	const [showBottomPanelToggle] = useShowBottomPanelToggle();
	const localProjectlessTaskFolder = isLocalNode(activeNode)
		? projectlessTaskFolder
		: null;
	// THIS TAB's composer target. Every chat tab stays mounted at once (Layout),
	// so this is deliberately per-instance state: nothing outside this ChatPage
	// may write it. The seed chain (merged-view pin → tab seed → last-used hint →
	// node default → the conversation's own pinned agent) lives in
	// `lib/composer-target.ts`; this initializer covers only its synchronous
	// links, and the two effects below cover the async ones.
	const [agentId, setAgentId] = useState<string | null>(() =>
		botProduct
			? "ryu"
			: seedComposerAgentId({
					// The merged view is *about* one agent, so it pins the target: opening it
					// must never inherit whichever agent happened to be picked last.
					pinnedAgentId: mergedAgentId,
					seededAgentId: initialAgent,
					lastUsedAgentId: readLastUsedAgentId(),
				})
	);
	// Read-only mirror for effects that must compare against the live target
	// WITHOUT re-running when it changes — see the conversation-hydration effect,
	// where depending on `agentId` is what reverted the user's own pick.
	const agentIdRef = useRef(agentId);
	agentIdRef.current = agentId;
	// Persistent group selection from the composer target picker. When set, every
	// turn fans out to the group's members (Core's `team_id` takes precedence over
	// `agent_id`). Session-only — distinct from the transient `@group` mention ref.
	const [teamId, setTeamId] = useState<string | null>(initialTeamId ?? null);
	const [agentTools, setAgentTools] = useState<string[]>([]);

	// One-shot seed from a `ryu://chat/new` deep link: pre-fill the composer and
	// pre-select the project folder. The agent is seeded above via initial state.
	// The prompt is NEVER auto-sent — only placed in the composer for review.
	const deepLinkSeeded = useRef(false);
	useEffect(() => {
		if (deepLinkSeeded.current) {
			return;
		}
		deepLinkSeeded.current = true;
		if (initialProject) {
			setFolder(initialProject).catch(() => {
				/* invalid path — leave the project unset */
			});
		}
	}, [initialProject, setFolder]);

	// Workspace panel open/close state (bottom + right panels)
	const [bottomPanelOpen, setBottomPanelOpen] = useState(false);
	const [rightPanelOpen, setRightPanelOpen] = useState(false);
	useEffect(() => {
		if (!showBottomPanelToggle) {
			setBottomPanelOpen(false);
		}
	}, [showBottomPanelToggle]);
	// With the workbench frame mounted, the panel buttons and shortcuts show
	// and hide the shared Right/Bottom panes; an empty Right pane opens this
	// chat's Context when no project tool fits. Read through refs so the
	// toggles stay stable while the workbench changes.
	const dockBridge = useWorkbenchDockBridge();
	const dockBridgeRef = useRef(dockBridge);
	dockBridgeRef.current = dockBridge;
	const chatContextPanelRef = useRef<WorkbenchToolOption | null>(null);
	const toggleBottomPanel = useCallback(() => {
		if (dockBridgeRef.current) {
			dockBridgeRef.current.toggleRegion("bottom");
		} else {
			setBottomPanelOpen((open) => !open);
		}
	}, []);
	const toggleRightPanel = useCallback(() => {
		if (dockBridgeRef.current) {
			const contextPanel = chatContextPanelRef.current;
			dockBridgeRef.current.toggleRegion(
				"right",
				contextPanel ? [contextPanel] : []
			);
		} else {
			setRightPanelOpen((open) => !open);
		}
	}, []);
	const bottomPanelShown = dockBridge
		? dockBridge.isRegionShown("bottom")
		: bottomPanelOpen;
	const rightPanelShown = dockBridge
		? dockBridge.isRegionShown("right")
		: rightPanelOpen;
	const [shareDialogOpen, setShareDialogOpen] = useState(false);
	const [rewindDialogOpen, setRewindDialogOpen] = useState(false);
	const [rewindPreselect, setRewindPreselect] =
		useState<RewindPreselect | null>(null);
	// After rewinding past the FIRST turn the version tree cannot point at an
	// empty thread, so the next prompt is sent as an edit of that turn.
	const pendingRewindEditRef = useRef<string | null>(null);
	const [imageEditorAsset, setImageEditorAsset] =
		useState<ImageEditorAsset | null>(null);
	const [drawesomeDialogOpen, setDrawesomeDialogOpen] = useState(false);
	const [drawesomeSourceImage, setDrawesomeSourceImage] = useState<{
		filename: string;
		url: string;
	} | null>(null);
	// User's intent for the "Pinned summary" sidebar (project ▸ branch ▸
	// worktree + git changes + commit&push). It docks as its own column stacked
	// with the right panel (both can be open at once); WorkspacePanels
	// auto-demotes it to a floating overlay when the chat gets too narrow.
	const [pinnedSummaryOpen, setPinnedSummaryOpen] = useState(true);
	const [pendingWorkspaceMessage, setPendingWorkspaceMessage] = useState<{
		attachments?: AttachedImage[];
		content: string;
		role: "user";
	} | null>(null);
	// Only the floating (auto-demoted) overlay overlaps the message column, so
	// only it dismisses on a press-away (the titlebar toggle brings it back).
	// Stable so the panel's outside-press listener isn't re-bound each render.
	const dismissPinnedSummary = useCallback(
		() => setPinnedSummaryOpen(false),
		[]
	);
	return {
		botProduct,
		coreReachable,
		connectionPhase,
		gatewayReachable,
		statusLoading,
		browserSnapshot,
		browserLocalAbortRef,
		forceCoreNextRef,
		handleSendRef,
		interfaceLevel,
		chatPickerPlacement,
		pluginContributions,
		drawesomeCompanion,
		pluginContributionsSettled,
		sideChatsPluginEnabled,
		ghostChatsPluginEnabled,
		expandedComposerPluginEnabled,
		statsPluginEnabled,
		folder,
		activeNode,
		showBottomPanelToggle,
		localProjectlessTaskFolder,
		agentId,
		setAgentId,
		agentIdRef,
		teamId,
		setTeamId,
		agentTools,
		setAgentTools,
		bottomPanelOpen,
		setBottomPanelOpen,
		rightPanelOpen,
		setRightPanelOpen,
		chatContextPanelRef,
		toggleBottomPanel,
		toggleRightPanel,
		bottomPanelShown,
		rightPanelShown,
		shareDialogOpen,
		setShareDialogOpen,
		rewindDialogOpen,
		setRewindDialogOpen,
		rewindPreselect,
		setRewindPreselect,
		pendingRewindEditRef,
		imageEditorAsset,
		setImageEditorAsset,
		drawesomeDialogOpen,
		setDrawesomeDialogOpen,
		drawesomeSourceImage,
		setDrawesomeSourceImage,
		pinnedSummaryOpen,
		setPinnedSummaryOpen,
		pendingWorkspaceMessage,
		setPendingWorkspaceMessage,
		dismissPinnedSummary,
	} as const;
}
