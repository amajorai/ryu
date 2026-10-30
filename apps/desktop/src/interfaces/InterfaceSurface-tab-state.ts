import type { InterfaceDescriptor } from "@ryuhq/protocol/interfaces";
import type { Tab } from "@/src/contexts/TabsContext.tsx";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { interfaceCredit } from "./registry.ts";

export function headerDescription(descriptor: InterfaceDescriptor): string {
	const credit = interfaceCredit(descriptor);
	if (credit === null) {
		return descriptor.description;
	}
	return `${descriptor.description || descriptor.label} · ${credit}`;
}

/** Identity of what a tab shows: navigating it in place changes the key. */
export function tabKey(tab: Tab | undefined): string {
	return tab ? `${tab.id}|${tab.path}|${tab.navToken ?? 0}` : "";
}

/** Primary folder of a workspace project, which `ChatPage` takes as its cwd. */
export function projectFolder(
	projectId: string | undefined
): string | undefined {
	if (!projectId) {
		return;
	}
	return useWorkspaceStore
		.getState()
		.projects.find((project) => project.id === projectId)?.folders[0];
}

/**
 * The interface's overview after the user left a tab: `closedId` is the tab
 * being closed, and `revealedKey` the tab that closing it revealed (null until
 * the close lands). Only that revealed tab stays hidden; any other navigation
 * (a deep link, a notification, a shortcut), including one that reopens the
 * revealed tab itself, shows normally.
 */
export interface OverviewState {
	closedId: string;
	revealedKey: string | null;
}
