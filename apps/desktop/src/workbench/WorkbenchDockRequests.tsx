import { useEffect } from "react";
import { restoreDockTabKind } from "@/src/components/panels/dock-panels.ts";
import { useDockPanelRequestStore } from "@/src/store/useDockPanelRequestStore.ts";
import { useProjectDockStore } from "@/src/store/useProjectDockStore.ts";
import { useSidePanelRouteStore } from "@/src/store/useSidePanelRouteStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { baseToolLabel } from "./dock-migration.ts";
import type { WorkbenchTools } from "./workbench-chrome.tsx";

/**
 * Serves the shell-wide panel requests (a page for the side, a terminal that
 * runs a command, an app panel) as workbench tabs, and moves the project's
 * pinned dock tabs into the workbench once. Mounted with the workbench frame,
 * which replaces the per-chat docks that used to consume these requests.
 */
export function WorkbenchDockRequests({
	openPanel,
}: {
	openPanel: WorkbenchTools["openPanel"];
}) {
	const pendingRoute = useSidePanelRouteStore((store) => store.pending);
	const clearPendingRoute = useSidePanelRouteStore((store) => store.clear);
	const pendingPanel = useDockPanelRequestStore((store) => store.pending);
	const clearPendingPanel = useDockPanelRequestStore((store) => store.clear);
	const folder = useWorkspaceStore((store) => store.folder);

	useEffect(() => {
		if (!pendingRoute) {
			return;
		}
		clearPendingRoute();
		openPanel({
			id: pendingRoute.kind,
			label: pendingRoute.label,
			region: "right",
		});
	}, [clearPendingRoute, openPanel, pendingRoute]);

	useEffect(() => {
		if (!pendingPanel) {
			return;
		}
		clearPendingPanel();
		openPanel(
			{
				id: pendingPanel.kind,
				label: pendingPanel.label,
				region: pendingPanel.side ?? "right",
			},
			{
				command: pendingPanel.command,
				// A command gets a terminal of its own, never a busy shell.
				forceNew: pendingPanel.command !== undefined,
				nonce: pendingPanel.nonce,
			}
		);
	}, [clearPendingPanel, openPanel, pendingPanel]);

	// Tabs pinned to the project's dock become the project's workbench tabs:
	// the workbench already shares them across every chat in the project.
	useEffect(() => {
		if (!folder) {
			return;
		}
		const { byFolder, removeTab } = useProjectDockStore.getState();
		for (const tab of byFolder[folder] ?? []) {
			if (!tab.pinned) {
				continue;
			}
			removeTab(folder, tab.uid);
			if (restoreDockTabKind(tab.kind).kind === "unavailable") {
				continue;
			}
			openPanel(
				{ id: tab.kind, label: baseToolLabel(tab.label), region: tab.side },
				{ activate: false, folder, forceNew: tab.kind === "terminal" }
			);
		}
	}, [folder, openPanel]);

	return null;
}
