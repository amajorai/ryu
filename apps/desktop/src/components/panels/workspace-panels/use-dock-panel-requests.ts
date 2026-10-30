import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";
import { useIsActiveTab } from "@/src/contexts/TabsContext.tsx";
import { useSessionBoxScreenRequest } from "@/src/hooks/useSessionBox.ts";
import { useDockPanelRequestStore } from "@/src/store/useDockPanelRequestStore.ts";
import type { ProjectDockTab } from "@/src/store/useProjectDockStore.ts";
import { useSidePanelRouteStore } from "@/src/store/useSidePanelRouteStore.ts";
import type { SubagentView } from "./native-dock-panels.tsx";
import type { TabKind } from "./tab-model.ts";
import type { usePanelTabs } from "./use-panel-tabs.ts";
import type { WorkspacePanelsProps } from "./workspace-panels-types.ts";

type PanelTabsState = ReturnType<typeof usePanelTabs>;
type SetUid = Dispatch<SetStateAction<string>>;

interface DockPanelRequestsInput
	extends Pick<
		WorkspacePanelsProps,
		| "agentActivityRequest"
		| "artifactRequest"
		| "bottomOpen"
		| "collectionRequest"
		| "contextRequest"
		| "contextView"
		| "cowork"
		| "fileReviewRequest"
		| "fileSearchRequest"
		| "inspectorRequest"
		| "onBottomOpenChange"
		| "onRightOpenChange"
		| "rightOpen"
		| "subagentRequest"
	> {
	bottomLocal: PanelTabsState;
	rightLocal: PanelTabsState;
	setBottomActiveUid: SetUid;
	setRightActiveUid: SetUid;
	setSubagentView: Dispatch<SetStateAction<SubagentView | null>>;
	visibleBottomProject: ProjectDockTab[];
	visibleRightProject: ProjectDockTab[];
}

/**
 * Opens (or re-focuses) dock tabs in response to the chat's nonce-keyed panel
 * requests and the shell-wide side-panel route and dock-panel request stores.
 */
export function useDockPanelRequests({
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
}: DockPanelRequestsInput) {
	// The artifact is carried ON the artifact tab itself (each artifact = one tab),
	// so there is no separate pinned artifact view — see `openArtifact`.
	// The raw message part currently pinned to the right panel's inspector tab.
	const [inspectorView, setInspectorView] = useState<unknown>(null);

	// Open (or re-focus) the subagent tab when ChatPage requests one. `openTab` is
	// re-created each render, so hold it in a ref and depend only on the request —
	// the effect fires once per click (the nonce makes each request distinct).
	const openBottomTabRef = useRef(bottomLocal.openTab);
	openBottomTabRef.current = bottomLocal.openTab;
	const openRightTabRef = useRef(rightLocal.openTab);
	openRightTabRef.current = rightLocal.openTab;
	const fileSearchNonce = fileSearchRequest?.nonce;
	useEffect(() => {
		if (fileSearchNonce === undefined) {
			return;
		}
		const projectFiles = visibleRightProject.find(
			(tab) => tab.kind === "files"
		);
		if (projectFiles) {
			setRightActiveUid(projectFiles.uid);
		} else {
			openRightTabRef.current("files", "Files");
		}
		if (!rightOpen) {
			onRightOpenChange(true);
		}
	}, [fileSearchNonce, onRightOpenChange, rightOpen, visibleRightProject]);
	useEffect(() => {
		setSubagentView(null);
	}, [cowork?.runId]);
	useEffect(() => {
		if (!fileReviewRequest) {
			return;
		}
		openRightTabRef.current("codereview", "Changes");
		if (!rightOpen) {
			onRightOpenChange(true);
		}
	}, [fileReviewRequest, onRightOpenChange, rightOpen]);

	// "View screen" (cloud task strip, sub-agent list): open or focus this
	// conversation's Box screen tab. The tab picks the requested Box itself.
	const boxScreenRequest = useSessionBoxScreenRequest(
		contextView?.conversationId
	);
	const handledBoxScreenNonce = useRef(boxScreenRequest?.nonce);
	useEffect(() => {
		if (
			!boxScreenRequest ||
			handledBoxScreenNonce.current === boxScreenRequest.nonce
		) {
			return;
		}
		handledBoxScreenNonce.current = boxScreenRequest.nonce;
		openRightTabRef.current("box-screen", "Box screen");
		if (!rightOpen) {
			onRightOpenChange(true);
		}
	}, [boxScreenRequest, onRightOpenChange, rightOpen]);

	useEffect(() => {
		if (!subagentRequest) {
			return;
		}
		setSubagentView({ id: subagentRequest.id, nonce: subagentRequest.nonce });
		// Keep list and detail inside one stable Subagents tab. The task title lives
		// in the detail header; changing the tab label itself made parallel work hard
		// to find again and leaked synthetic persona names into navigation.
		openRightTabRef.current("subagents", "Subagents");
	}, [subagentRequest]);

	// Rendered/canvas artifacts: each one opens its OWN dock tab (no one-at-a-time
	// limit), and re-opening the same artifact re-focuses it. `openArtifact` is
	// re-created each render, so hold it in a ref and depend only on the request.
	const openArtifactRef = useRef(rightLocal.openArtifact);
	openArtifactRef.current = rightLocal.openArtifact;
	useEffect(() => {
		if (!artifactRequest) {
			return;
		}
		openArtifactRef.current(artifactRequest.artifact);
	}, [artifactRequest]);

	// Same one-tab-reuse + nonce-refocus flow for the raw part inspector. The
	// inspector lives in its OWN reusable tab, so opening it never clobbers the
	// artifact/subagent tabs (they simply sit alongside it — no fight over one
	// shared right-panel slot).
	useEffect(() => {
		if (!inspectorRequest) {
			return;
		}
		setInspectorView(inspectorRequest.part);
		openRightTabRef.current("inspector", "Inspector");
	}, [inspectorRequest]);

	// Same one-tab-reuse + nonce-refocus flow for the context breakdown. No local
	// view state to set: the tab reads `contextView` live, so clicking the ring
	// only has to open (or re-focus) the tab.
	useEffect(() => {
		if (!contextRequest) {
			return;
		}
		openRightTabRef.current("context", "Context");
	}, [contextRequest]);

	useEffect(() => {
		if (!agentActivityRequest) {
			return;
		}
		openRightTabRef.current("agent-activity", "Agent activity");
		if (!rightOpen) {
			onRightOpenChange(true);
		}
	}, [agentActivityRequest, onRightOpenChange, rightOpen]);

	// A capped pinned-summary section raises its complete collection in a reusable
	// workspace tab. The panel reads `cowork.messages` live, so the list continues
	// to update after it opens.
	useEffect(() => {
		if (!collectionRequest) {
			return;
		}
		if (collectionRequest.kind === "subagents") {
			setSubagentView(null);
		}
		const label =
			collectionRequest.kind === "sources" ? "Sources" : "Subagents";
		openRightTabRef.current(collectionRequest.kind, label);
	}, [collectionRequest]);

	// Same flow for a PAGE raised in the right dock — but sourced from a store
	// rather than a prop, because its callers are all over the shell (a command, a
	// tab menu, an agent-facing seam) and none of them own this component.
	//
	// Two guards, both load-bearing. Only the FOCUSED window tab consumes a
	// request: every open chat mounts its own docks, so without this one click
	// would open the page in all of them. And the request is CLEARED on consumption
	// so a background tab brought forward later doesn't replay a stale one.
	const pendingRoute = useSidePanelRouteStore((s) => s.pending);
	const clearPendingRoute = useSidePanelRouteStore((s) => s.clear);
	const pendingDockPanel = useDockPanelRequestStore((s) => s.pending);
	const clearPendingDockPanel = useDockPanelRequestStore((s) => s.clear);
	const isFocusedWindowTab = useIsActiveTab();
	useEffect(() => {
		if (!(pendingRoute && isFocusedWindowTab)) {
			return;
		}
		clearPendingRoute();
		// A page pinned to the PROJECT dock is already showing this exact page (the
		// kind carries the path), so focus it rather than stacking a chat-local
		// second copy of the same thing beside it.
		const pinnedSame = visibleRightProject.find(
			(t) => t.kind === pendingRoute.kind
		);
		if (pinnedSame) {
			setRightActiveUid(pinnedSame.uid);
		} else {
			openRightTabRef.current(pendingRoute.kind, pendingRoute.label);
		}
		if (!rightOpen) {
			onRightOpenChange(true);
		}
	}, [
		pendingRoute,
		isFocusedWindowTab,
		clearPendingRoute,
		visibleRightProject,
		rightOpen,
		onRightOpenChange,
	]);

	useEffect(() => {
		if (!(pendingDockPanel && isFocusedWindowTab)) {
			return;
		}
		clearPendingDockPanel();
		const side = pendingDockPanel.side ?? "right";
		const isBottom = side === "bottom";
		const projectTabs = isBottom ? visibleBottomProject : visibleRightProject;
		const pinnedSame = projectTabs.find(
			(tab) => tab.kind === pendingDockPanel.kind
		);
		if (pinnedSame && !pendingDockPanel.command) {
			if (isBottom) {
				setBottomActiveUid(pinnedSame.uid);
			} else {
				setRightActiveUid(pinnedSame.uid);
			}
		} else if (isBottom) {
			// SAFETY: All dock-request producers publish terminal, the browser plugin constant, or dockTabKind's plugin-tagged result; each is a TabKind member.
			openBottomTabRef.current(
				pendingDockPanel.kind as TabKind,
				pendingDockPanel.label,
				pendingDockPanel.command,
				pendingDockPanel.nonce
			);
		} else {
			// SAFETY: All dock-request producers publish terminal, the browser plugin constant, or dockTabKind's plugin-tagged result; each is a TabKind member.
			openRightTabRef.current(
				pendingDockPanel.kind as TabKind,
				pendingDockPanel.label,
				pendingDockPanel.command,
				pendingDockPanel.nonce
			);
		}
		if (isBottom ? !bottomOpen : !rightOpen) {
			if (isBottom) {
				onBottomOpenChange(true);
			} else {
				onRightOpenChange(true);
			}
		}
	}, [
		pendingDockPanel,
		isFocusedWindowTab,
		clearPendingDockPanel,
		visibleBottomProject,
		visibleRightProject,
		bottomOpen,
		rightOpen,
		onBottomOpenChange,
		onRightOpenChange,
	]);
	return { inspectorView, isFocusedWindowTab };
}
