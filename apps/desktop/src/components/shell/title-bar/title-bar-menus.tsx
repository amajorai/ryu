import {
	Add01Icon,
	ArrowLeft01Icon,
	ArrowRight01Icon,
	ArrowShrink02Icon,
	ArrowShrinkIcon,
	ArrowTurnBackwardIcon,
	Delete02Icon,
	FullScreenIcon,
	GridIcon,
	SidebarTopIcon,
	UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ContextMenu,
	ContextMenuCheckboxItem,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	TabBarAppearanceMenuItems,
	TabLayoutMenuItems,
} from "@/src/components/layout/appearance-context-menu.tsx";
import type { Split, Tab } from "@/src/contexts/TabsContext.tsx";
import { findSplit } from "@/src/contexts/TabsContext.tsx";
import { setTabLayout, type TabLayout } from "@/src/hooks/useTabLayout.ts";
import { setTabSizing, type TabSizing } from "@/src/hooks/useTabSizing.ts";
import { MoveTabToRegionMenu } from "./tab-menu-items.tsx";

export interface TabStripContextMenuContentProps {
	activeTabId: string;
	activeTabIndex: number;
	autoHideTitleBar: boolean;
	closeTab: (id: string) => void;
	floatingTabs: boolean;
	handleNewTab: () => void;
	handleToggleFullscreen: () => void;
	hasClosedTabs: boolean;
	isFullscreen: boolean;
	restoreTab: () => void;
	setAutoHideTitleBar: (value: boolean) => void;
	setFloatingTabs: (value: boolean) => void;
	setTabDropdownEnabled: (value: boolean) => void;
	setTabSearchButtonVisible: (value: boolean) => void;
	splits: Split[];
	tabDropdownEnabled: boolean;
	tabLayout: TabLayout;
	tabSearchButtonVisible: boolean;
	tabSizing: TabSizing;
	tabs: Tab[];
	toggleSplitActive: () => void;
}

/** The horizontal tab strip's right-click menu. */
export function TabStripContextMenuContent({
	activeTabId,
	activeTabIndex,
	autoHideTitleBar,
	closeTab,
	floatingTabs,
	handleNewTab,
	handleToggleFullscreen,
	hasClosedTabs,
	isFullscreen,
	restoreTab,
	setAutoHideTitleBar,
	setFloatingTabs,
	setTabDropdownEnabled,
	setTabSearchButtonVisible,
	splits,
	tabDropdownEnabled,
	tabLayout,
	tabSearchButtonVisible,
	tabSizing,
	tabs,
	toggleSplitActive,
}: TabStripContextMenuContentProps) {
	return (
		<ContextMenuContent>
			<MoveTabToRegionMenu tabId={activeTabId} />
			<ContextMenuItem onClick={handleNewTab}>
				<HugeiconsIcon className="size-4" icon={Add01Icon} />
				New tab
			</ContextMenuItem>
			<ContextMenuItem disabled={!hasClosedTabs} onClick={restoreTab}>
				<HugeiconsIcon className="size-4" icon={ArrowTurnBackwardIcon} />
				Restore closed tab
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem disabled={!activeTabId} onClick={toggleSplitActive}>
				<HugeiconsIcon className="size-4" icon={GridIcon} />
				{activeTabId && findSplit(tabs, splits, activeTabId)
					? "Unsplit active tab"
					: "Split active tab"}
			</ContextMenuItem>
			<ContextMenuItem
				onClick={() => setTabSizing(tabSizing === "fit" ? "fixed" : "fit")}
			>
				<HugeiconsIcon
					className="size-4"
					icon={tabSizing === "fit" ? UnfoldMoreIcon : ArrowShrinkIcon}
				/>
				{tabSizing === "fit" ? "Use fixed-width tabs" : "Fit tabs to width"}
			</ContextMenuItem>
			<TabLayoutMenuItems onChange={setTabLayout} value={tabLayout} />
			<TabBarAppearanceMenuItems
				floatingTabs={floatingTabs}
				setFloatingTabs={setFloatingTabs}
				setTabDropdownEnabled={setTabDropdownEnabled}
				setTabSearchButtonVisible={setTabSearchButtonVisible}
				tabDropdownEnabled={tabDropdownEnabled}
				tabSearchButtonVisible={tabSearchButtonVisible}
			/>
			<ContextMenuCheckboxItem
				checked={autoHideTitleBar}
				onCheckedChange={setAutoHideTitleBar}
			>
				<HugeiconsIcon className="size-4" icon={SidebarTopIcon} />
				Auto-hide title bar
			</ContextMenuCheckboxItem>
			<ContextMenuItem onClick={handleToggleFullscreen}>
				<HugeiconsIcon
					className="size-4"
					icon={isFullscreen ? ArrowShrink02Icon : FullScreenIcon}
				/>
				{isFullscreen ? "Exit full screen" : "Enter full screen"}
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem
				disabled={
					activeTabIndex <= 0 ||
					!tabs.slice(0, activeTabIndex).some((tab) => !tab.pinned)
				}
				onClick={() => {
					for (const t of tabs.slice(0, activeTabIndex)) {
						if (!t.pinned) {
							closeTab(t.id);
						}
					}
				}}
			>
				<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
				Close tabs to the left
			</ContextMenuItem>
			<ContextMenuItem
				disabled={
					activeTabIndex < 0 ||
					!tabs.slice(activeTabIndex + 1).some((tab) => !tab.pinned)
				}
				onClick={() => {
					for (const t of tabs.slice(activeTabIndex + 1)) {
						if (!t.pinned) {
							closeTab(t.id);
						}
					}
				}}
			>
				<HugeiconsIcon className="size-4" icon={ArrowRight01Icon} />
				Close tabs to the right
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem
				disabled={tabs.length === 0}
				onClick={() => {
					for (const t of Array.from(tabs)) {
						closeTab(t.id);
					}
				}}
			>
				<HugeiconsIcon className="size-4" icon={Delete02Icon} />
				Close all tabs
			</ContextMenuItem>
		</ContextMenuContent>
	);
}

/** The drag-region spacer and its menu when another view owns the tabs. */
export function TitleBarDragContextMenu({
	autoHideTitleBar,
	handleToggleFullscreen,
	isFullscreen,
	onOpenChange,
	setAutoHideTitleBar,
	tabLayout,
}: {
	autoHideTitleBar: boolean;
	handleToggleFullscreen: () => void;
	isFullscreen: boolean;
	onOpenChange: (open: boolean) => void;
	setAutoHideTitleBar: (value: boolean) => void;
	tabLayout: TabLayout;
}) {
	return (
		<ContextMenu onOpenChange={onOpenChange}>
			<ContextMenuTrigger
				className="h-full min-w-0 flex-1"
				data-tauri-drag-region
			>
				<div className="h-full min-w-0 flex-1" data-tauri-drag-region />
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuCheckboxItem
					checked={autoHideTitleBar}
					onCheckedChange={setAutoHideTitleBar}
				>
					<HugeiconsIcon className="size-4" icon={SidebarTopIcon} />
					Auto-hide title bar
				</ContextMenuCheckboxItem>
				<ContextMenuItem onClick={handleToggleFullscreen}>
					<HugeiconsIcon
						className="size-4"
						icon={isFullscreen ? ArrowShrink02Icon : FullScreenIcon}
					/>
					{isFullscreen ? "Exit full screen" : "Enter full screen"}
				</ContextMenuItem>
				<TabLayoutMenuItems onChange={setTabLayout} value={tabLayout} />
			</ContextMenuContent>
		</ContextMenu>
	);
}
