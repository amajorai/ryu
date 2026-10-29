import type { ContextType } from "react";
import type { TabsContext } from "../../src/contexts/TabsContext.tsx";

type TabsProofContext = NonNullable<ContextType<typeof TabsContext>>;

function unavailableAction(): never {
	throw new Error(
		"This tab action is not implemented by the current proof fixture."
	);
}

/** Unimplemented actions fail loudly; each proof supplies the behavior it exercises. */
export function createTabsProofContext(
	overrides: Partial<TabsProofContext>
): TabsProofContext {
	return {
		activateTab: unavailableAction,
		activeTabId: "",
		addTabToGroup: unavailableAction,
		addTabToSplit: unavailableAction,
		applySplitPreset: unavailableAction,
		applySplitPresetToNewTabs: unavailableAction,
		bindTabConversation: unavailableAction,
		canGoBack: false,
		canGoForward: false,
		clearScrollToMessage: unavailableAction,
		closeGroup: unavailableAction,
		closeTab: unavailableAction,
		createGroup: unavailableAction,
		equalizeSplit: unavailableAction,
		focusTab: unavailableAction,
		goBack: unavailableAction,
		goForward: unavailableAction,
		groups: [],
		hasClosedTabs: false,
		moveTab: unavailableAction,
		openTab: unavailableAction,
		prepareTabForWorkbenchSplit: unavailableAction,
		removeFromSplit: unavailableAction,
		removeTabFromGroup: unavailableAction,
		renameGroup: unavailableAction,
		renameSplit: unavailableAction,
		replacePaneTab: unavailableAction,
		requestScrollToMessage: unavailableAction,
		restoreTab: unavailableAction,
		setGroupColor: unavailableAction,
		setSplitColor: unavailableAction,
		setSplitOrientation: unavailableAction,
		setSplitSizes: unavailableAction,
		setTabRoute: unavailableAction,
		splitPane: unavailableAction,
		splits: [],
		splitTabs: unavailableAction,
		swapSplitPanes: unavailableAction,
		tabs: [],
		toggleGroupCollapsed: unavailableAction,
		togglePin: unavailableAction,
		toggleSplitCollapsed: unavailableAction,
		ungroup: unavailableAction,
		unloadTab: unavailableAction,
		unsplit: unavailableAction,
		updateTabBusy: unavailableAction,
		updateTabIcon: unavailableAction,
		updateTabsIconWhere: unavailableAction,
		updateTabTitle: unavailableAction,
		updateTabWorkspaceSession: unavailableAction,
		updateTabWorktreeMode: unavailableAction,
		...overrides,
	};
}
