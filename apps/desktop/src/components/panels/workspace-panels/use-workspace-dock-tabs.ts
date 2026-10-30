import { useEffect, useMemo, useRef, useState } from "react";
import {
	type DockSide,
	restoreDockTabKind,
} from "@/src/components/panels/dock-panels.ts";
import {
	useCurrentTabId,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import type {
	WorkspaceSessionDock,
	WorkspaceSessionState,
} from "@/src/lib/workspace-session.ts";
import {
	useProjectDockStore,
	visibleProjectDockTabs,
} from "@/src/store/useProjectDockStore.ts";
import {
	findRestoredTabUid,
	type PanelTab,
	restoreLocalPanelTabs,
	serializeWorkspaceDock,
} from "./tab-model.ts";
import { usePanelTabs } from "./use-panel-tabs.ts";
import type { WorkspacePanelsProps } from "./workspace-panels-types.ts";

/**
 * The chat's two docks' tab lists: chat-local tabs plus the project-shared tabs
 * for the open folder, the strip selections, and the per-window-tab session
 * snapshot that restores them after a relaunch.
 */
export function useWorkspaceDockTabs({
	bottomOpen,
	folder,
	onBottomOpenChange,
	onRightOpenChange,
	rightOpen,
}: Pick<
	WorkspacePanelsProps,
	| "bottomOpen"
	| "folder"
	| "onBottomOpenChange"
	| "onRightOpenChange"
	| "rightOpen"
>) {
	const { tabs: windowTabs, updateTabWorkspaceSession } = useTabsContext();
	const currentTabId = useCurrentTabId();
	const currentWindowTab = windowTabs.find((tab) => tab.id === currentTabId);
	// Read the snapshot once. Later writes update the parent Tab, but must not
	// re-seed this dock and wipe the live React state we are trying to remember.
	const initialWorkspaceRef = useRef<WorkspaceSessionState | undefined>(
		currentWindowTab?.workspaceSession
	);
	const initialWorkspace = initialWorkspaceRef.current;
	const hasProjectTabs = Boolean(
		initialWorkspace?.bottom.tabs.some((tab) => tab.project) ||
			initialWorkspace?.right.tabs.some((tab) => tab.project)
	);
	const [workspaceRestoreReady, setWorkspaceRestoreReady] = useState(
		() => initialWorkspace === undefined
	);
	const restoredBottomTabs = useMemo(
		() => restoreLocalPanelTabs(initialWorkspace?.bottom),
		[initialWorkspace]
	);
	const restoredRightTabs = useMemo(
		() => restoreLocalPanelTabs(initialWorkspace?.right),
		[initialWorkspace]
	);
	const bottomLocal = usePanelTabs(restoredBottomTabs);
	const rightLocal = usePanelTabs(restoredRightTabs);
	// Chat-local tabs (cowork / subagent / artifact / inspector, and shareable
	// kinds when no project folder is open). Project-shareable tabs live in
	// `useProjectDockStore` so pinning can surface the same live instance in
	// every chat for the folder.
	const projectByFolder = useProjectDockStore((s) => s.byFolder);
	const addProjectTab = useProjectDockStore((s) => s.addTab);
	const removeProjectTab = useProjectDockStore((s) => s.removeTab);
	const toggleProjectPin = useProjectDockStore((s) => s.togglePin);
	const setProjectSide = useProjectDockStore((s) => s.setSide);
	const clearProjectOwner = useProjectDockStore((s) => s.clearOwner);

	const projectTabs = folder ? (projectByFolder[folder] ?? []) : [];

	// Drop this chat's unpinned project tabs when the window-tab unmounts so a
	// closed conversation does not leave orphan terminals around.
	useEffect(() => {
		if (!(folder && currentTabId)) {
			return;
		}
		return () => {
			clearProjectOwner(folder, currentTabId);
		};
	}, [folder, currentTabId, clearProjectOwner]);

	const visibleBottomProject = useMemo(
		() => visibleProjectDockTabs(projectTabs, "bottom", currentTabId),
		[projectTabs, currentTabId]
	);
	const visibleRightProject = useMemo(
		() => visibleProjectDockTabs(projectTabs, "right", currentTabId),
		[projectTabs, currentTabId]
	);

	// Recreate unpinned project tabs after a relaunch or an auto-unload. Pinned
	// tabs normally arrive from the project store already; matching them here
	// avoids creating a second copy while still restoring the chat's order.
	const restoredProjectFoldersRef = useRef(new Set<string>());
	useEffect(() => {
		if (
			!(initialWorkspace && hasProjectTabs && folder && currentTabId) ||
			restoredProjectFoldersRef.current.has(folder)
		) {
			return;
		}

		const restoreSide = (side: DockSide, dock: WorkspaceSessionDock) => {
			let known = [...(useProjectDockStore.getState().byFolder[folder] ?? [])];
			const used = new Set<string>();
			for (const descriptor of dock.tabs) {
				const rendererKind = restoreDockTabKind(descriptor.kind).kind;
				if (!descriptor.project || rendererKind === "unavailable") {
					continue;
				}
				const existing = known.find(
					(tab) =>
						!used.has(tab.uid) &&
						tab.side === side &&
						((descriptor.uid !== undefined && tab.uid === descriptor.uid) ||
							(tab.kind === descriptor.kind &&
								tab.label === descriptor.label &&
								(tab.pinned || tab.ownerTabId === currentTabId)))
				);
				const restored =
					existing ??
					addProjectTab(folder, {
						kind: rendererKind,
						label: descriptor.label,
						side,
						pinned: descriptor.pinned === true,
						ownerTabId: currentTabId,
						...(descriptor.uid ? { uid: descriptor.uid } : undefined),
					});
				used.add(restored.uid);
				if (!existing) {
					known = [...known, restored];
				}
			}
		};

		restoreSide("bottom", initialWorkspace.bottom);
		restoreSide("right", initialWorkspace.right);
		restoredProjectFoldersRef.current.add(folder);
		setWorkspaceRestoreReady(true);
	}, [addProjectTab, currentTabId, folder, hasProjectTabs, initialWorkspace]);

	// Restore dock visibility before the first snapshot write. Without this
	// guard, the initial `false` props would overwrite a saved open panel.
	useEffect(() => {
		if (!initialWorkspace) {
			return;
		}
		onBottomOpenChange(initialWorkspace.bottomOpen);
		onRightOpenChange(initialWorkspace.rightOpen);
		if (!hasProjectTabs) {
			setWorkspaceRestoreReady(true);
		}
	}, [hasProjectTabs, initialWorkspace, onBottomOpenChange, onRightOpenChange]);

	const bottomTabs = useMemo((): PanelTab[] => {
		const project: PanelTab[] = visibleBottomProject.map((t) => ({
			uid: t.uid,
			...restoreDockTabKind(t.kind),
			label: t.label,
			pinned: t.pinned,
			projectHosted: true,
		}));
		const pinned = project.filter((t) => t.pinned);
		const unpinned = project.filter((t) => !t.pinned);
		return [...pinned, ...unpinned, ...bottomLocal.tabs];
	}, [visibleBottomProject, bottomLocal.tabs]);

	const rightTabs = useMemo((): PanelTab[] => {
		const project: PanelTab[] = visibleRightProject.map((t) => ({
			uid: t.uid,
			...restoreDockTabKind(t.kind),
			label: t.label,
			pinned: t.pinned,
			projectHosted: true,
		}));
		const pinned = project.filter((t) => t.pinned);
		const unpinned = project.filter((t) => !t.pinned);
		return [...pinned, ...unpinned, ...rightLocal.tabs];
	}, [visibleRightProject, rightLocal.tabs]);

	const [bottomActiveUid, setBottomActiveUid] = useState("");
	const [rightActiveUid, setRightActiveUid] = useState("");

	// Keep the strip selection valid as tabs come and go (including pinned tabs
	// that appear because another chat pinned them).
	useEffect(() => {
		if (bottomTabs.length === 0) {
			if (bottomActiveUid) {
				setBottomActiveUid("");
			}
			return;
		}
		if (!bottomTabs.some((t) => t.uid === bottomActiveUid)) {
			setBottomActiveUid(bottomTabs[0]?.uid ?? "");
		}
	}, [bottomTabs, bottomActiveUid]);

	useEffect(() => {
		if (rightTabs.length === 0) {
			if (rightActiveUid) {
				setRightActiveUid("");
			}
			return;
		}
		if (!rightTabs.some((t) => t.uid === rightActiveUid)) {
			setRightActiveUid(rightTabs[0]?.uid ?? "");
		}
	}, [rightTabs, rightActiveUid]);

	// Mirror local-hook focus into the merged selection (chat-only tabs).
	useEffect(() => {
		if (bottomLocal.tabs.some((t) => t.uid === bottomLocal.activeUid)) {
			setBottomActiveUid(bottomLocal.activeUid);
		}
	}, [bottomLocal.activeUid, bottomLocal.tabs]);

	useEffect(() => {
		if (rightLocal.tabs.some((t) => t.uid === rightLocal.activeUid)) {
			setRightActiveUid(rightLocal.activeUid);
		}
	}, [rightLocal.activeUid, rightLocal.tabs]);

	// The runtime uids are deliberately not persisted. Restore focus by the
	// serialized tab identity after project-hosted tabs have been rehydrated.
	const restoredSelectionRef = useRef(false);
	useEffect(() => {
		if (
			!(initialWorkspace && workspaceRestoreReady) ||
			restoredSelectionRef.current
		) {
			return;
		}
		const bottomTarget =
			initialWorkspace.bottom.tabs[initialWorkspace.bottom.activeIndex];
		const rightTarget =
			initialWorkspace.right.tabs[initialWorkspace.right.activeIndex];
		setBottomActiveUid(findRestoredTabUid(bottomTabs, bottomTarget));
		setRightActiveUid(findRestoredTabUid(rightTabs, rightTarget));
		restoredSelectionRef.current = true;
	}, [bottomTabs, initialWorkspace, rightTabs, workspaceRestoreReady]);

	const workspaceSession = useMemo<WorkspaceSessionState>(
		() => ({
			bottom: serializeWorkspaceDock(bottomTabs, bottomActiveUid),
			bottomOpen,
			right: serializeWorkspaceDock(rightTabs, rightActiveUid),
			rightOpen,
		}),
		[
			bottomActiveUid,
			bottomOpen,
			bottomTabs,
			rightActiveUid,
			rightOpen,
			rightTabs,
		]
	);

	// Snapshot changes on every tab add/remove/focus and on panel visibility
	// changes. The parent owns this field so the existing top-level session
	// restore automatically carries the dock state with the chat tab.
	useEffect(() => {
		if (!(currentTabId && workspaceRestoreReady)) {
			return;
		}
		updateTabWorkspaceSession(currentTabId, workspaceSession);
	}, [
		currentTabId,
		updateTabWorkspaceSession,
		workspaceRestoreReady,
		workspaceSession,
	]);
	return {
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
	};
}
