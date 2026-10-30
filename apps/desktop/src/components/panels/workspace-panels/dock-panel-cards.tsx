import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { Dispatch, SetStateAction } from "react";
import type { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import type { SubagentView } from "./native-dock-panels.tsx";
import type { TabIconSpec } from "./panel-tab-bar.tsx";
import { PanelEmptyState, PanelTabBar } from "./panel-tab-bar.tsx";
import { ProjectDockContentSlot, TabContent } from "./tab-content.tsx";
import type { TabKind, TabTypeDef } from "./tab-model.ts";
import { PAGE_TAB_TYPES, type PanelTab } from "./tab-model.ts";
import type { WorkspacePanelsProps } from "./workspace-panels-types.ts";

type DockPanelsList = ReturnType<typeof usePluginContributions>["dock_panels"];

interface DockCardShared
	extends Pick<
		WorkspacePanelsProps,
		"agentActivityPanel" | "contextView" | "fileReviewRequest" | "folder"
	> {
	dockPanels: DockPanelsList;
	floatingChrome: boolean;
	iconForKind: (kind: TabKind) => TabIconSpec;
	isFocusedWindowTab: boolean;
	onTogglePin: (uid: string) => void;
	panelChrome: string;
	pinDisabledReason: string | undefined;
}

export interface BottomDockCardInput extends DockCardShared {
	activeBottomTab: PanelTab | undefined;
	addBottomTab: (kind: TabKind) => void;
	bottomActiveUid: string;
	bottomTabs: PanelTab[];
	bottomTabTypes: TabTypeDef[];
	closeBottomAll: () => void;
	closeBottomOthers: (uid: string) => void;
	closeBottomTab: (uid: string) => void;
	moveTabToRight: (uid: string) => void;
	setBottomActiveUid: (uid: string) => void;
}

export interface RightDockCardInput
	extends DockCardShared,
		Pick<WorkspacePanelsProps, "cowork"> {
	activeRightTab: PanelTab | undefined;
	addRightTab: (kind: TabKind) => void;
	closeRightAll: () => void;
	closeRightOthers: (uid: string) => void;
	closeRightTab: (uid: string) => void;
	inspectorView: unknown;
	moveTabToBottom: (uid: string) => void;
	rightActiveUid: string;
	rightTabs: PanelTab[];
	rightTabTypes: TabTypeDef[];
	setRightActiveUid: (uid: string) => void;
	setSubagentView: Dispatch<SetStateAction<SubagentView | null>>;
	subagentView: SubagentView | null;
}

/** The bottom dock's card: its tab strip over the active tab's content. */
export function renderBottomDockCard(
	{
		activeBottomTab,
		addBottomTab,
		agentActivityPanel,
		bottomActiveUid,
		bottomTabTypes,
		bottomTabs,
		closeBottomAll,
		closeBottomOthers,
		closeBottomTab,
		contextView,
		dockPanels,
		fileReviewRequest,
		floatingChrome,
		folder,
		iconForKind,
		isFocusedWindowTab,
		moveTabToRight,
		onTogglePin,
		panelChrome,
		pinDisabledReason,
		setBottomActiveUid,
	}: BottomDockCardInput,
	onClosePanel: () => void
) {
	return (
		<div
			className={cn(
				panelChrome,
				"min-h-0",
				floatingChrome ? "mx-2 mb-2" : null
			)}
		>
			<PanelTabBar
				activeUid={bottomActiveUid}
				addTypes={bottomTabTypes}
				iconForKind={iconForKind}
				onActivate={setBottomActiveUid}
				onAdd={addBottomTab}
				onCloseAll={closeBottomAll}
				onCloseOthers={closeBottomOthers}
				onClosePanel={onClosePanel}
				onCloseTab={closeBottomTab}
				onMoveToOtherPanel={moveTabToRight}
				onTogglePin={onTogglePin}
				otherPanelIcon={ArrowRight01Icon}
				otherPanelLabel="right panel"
				pinDisabledReason={pinDisabledReason}
				tabs={bottomTabs}
			/>
			<div className="min-h-0 flex-1 overflow-hidden">
				{activeBottomTab?.projectHosted ? (
					<ProjectDockContentSlot active uid={activeBottomTab.uid} />
				) : activeBottomTab ? (
					<TabContent
						active={isFocusedWindowTab}
						agentActivityPanel={agentActivityPanel}
						contextView={contextView}
						dockPanels={dockPanels}
						fileReviewRequest={fileReviewRequest}
						folder={folder}
						tab={activeBottomTab}
					/>
				) : (
					<PanelEmptyState addTypes={bottomTabTypes} onAdd={addBottomTab} />
				)}
			</div>
		</div>
	);
}

/** The right dock's card: its tab strip over the active tab's content. */
export function renderRightDockCard(
	{
		activeRightTab,
		addRightTab,
		agentActivityPanel,
		closeRightAll,
		closeRightOthers,
		closeRightTab,
		contextView,
		cowork,
		dockPanels,
		fileReviewRequest,
		floatingChrome,
		folder,
		iconForKind,
		inspectorView,
		isFocusedWindowTab,
		moveTabToBottom,
		onTogglePin,
		panelChrome,
		pinDisabledReason,
		rightActiveUid,
		rightTabTypes,
		rightTabs,
		setRightActiveUid,
		setSubagentView,
		subagentView,
	}: RightDockCardInput,
	onClosePanel: () => void
) {
	return (
		<div
			className={cn(
				panelChrome,
				"min-w-0",
				floatingChrome ? "my-2 mr-2" : null
			)}
		>
			<PanelTabBar
				activeUid={rightActiveUid}
				addTypes={rightTabTypes}
				iconForKind={iconForKind}
				onActivate={setRightActiveUid}
				onAdd={addRightTab}
				onCloseAll={closeRightAll}
				onCloseOthers={closeRightOthers}
				onClosePanel={onClosePanel}
				onCloseTab={closeRightTab}
				onMoveToOtherPanel={moveTabToBottom}
				onTogglePin={onTogglePin}
				otherPanelIcon={ArrowDown01Icon}
				otherPanelLabel="bottom panel"
				pageTypes={PAGE_TAB_TYPES}
				pinDisabledReason={pinDisabledReason}
				tabs={rightTabs}
			/>
			<div className="min-h-0 flex-1 overflow-hidden">
				{activeRightTab?.projectHosted ? (
					<ProjectDockContentSlot active uid={activeRightTab.uid} />
				) : activeRightTab ? (
					<TabContent
						active={isFocusedWindowTab}
						agentActivityPanel={agentActivityPanel}
						contextView={contextView}
						cowork={cowork}
						dockPanels={dockPanels}
						fileReviewRequest={fileReviewRequest}
						folder={folder}
						inspectorView={inspectorView}
						onClearSubagentView={() => setSubagentView(null)}
						subagentView={subagentView}
						tab={activeRightTab}
					/>
				) : (
					<PanelEmptyState addTypes={rightTabTypes} onAdd={addRightTab} />
				)}
			</div>
		</div>
	);
}
