import { useI18n } from "@ryu/i18n/react";
import {
	ContextMenu,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarRail,
} from "@ryu/ui/components/sidebar.tsx";
import { memo, useMemo, useRef, useState } from "react";
import { CreateAgentDialog } from "@/src/components/agents/LazyCreateAgentDialog.tsx";
import { NewAutomationDialog } from "@/src/components/calendar/NewAutomationDialog.tsx";
import { ImportSetupDialog } from "@/src/components/chat/ImportSetupDialog.tsx";
import { ImportThreadsDialog } from "@/src/components/chat/ImportThreadsDialog.tsx";
import { ResourceVisibilityConfirmationDialog } from "@/src/components/layout/ResourceVisibilityConfirmationDialog.tsx";
import { LiveActivitiesSection } from "@/src/components/live/LiveActivitiesSection.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { useConsoleAccess } from "@/src/hooks/useConsoleAccess.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { useSidebarVariant } from "@/src/hooks/useSidebarVariant.ts";
import { useTabLayout } from "@/src/hooks/useTabLayout.ts";
import { useVisibilityAdminAccess } from "@/src/hooks/useVisibilityAdminAccess.ts";
import { isCoreAppTier } from "@/src/lib/api/plugins.ts";
import { useNotificationLayout } from "@/src/lib/notification-layout.ts";
import {
	hasPluginChatFeature,
	SIDE_CHAT_FEATURE_KIND,
	SIDE_CHATS_PLUGIN_ID,
} from "@/src/lib/plugin-chat-features.ts";
import { useProductMode } from "@/src/lib/product-mode.ts";
import { AllComputersSidebar } from "./AllComputersSidebar.tsx";
import { AnnouncementsSection } from "./AnnouncementsSection.tsx";
import { useSidebarChatRows } from "./AppSidebar-chat-rows.ts";
import { SidebarRootContextMenuContent } from "./AppSidebar-context-menu.tsx";
import { useSidebarAutoImport } from "./AppSidebar-conversation-sync.ts";
import { useConversationVisibilityRequest } from "./AppSidebar-conversation-visibility.ts";
import { SidebarCustomizeDialog } from "./AppSidebar-customize-dialog.tsx";
import { SidebarPanelHeader } from "./AppSidebar-header.tsx";
import { useSidebarLayout } from "./AppSidebar-layout.ts";
import { useSidebarPanelMode } from "./AppSidebar-mode.ts";
import { renderSidebarSection } from "./AppSidebar-render-section.tsx";
import { resolveTabbedSections } from "./AppSidebar-tabbed-nav.tsx";
import { NavUser } from "./NavUser.tsx";
import { SidebarSectionNav } from "./SidebarSectionNav.tsx";
import { ChatGroupingContext } from "./sidebar-chat-grouping.tsx";
import {
	SIDEBAR_CHAT_SCOPE_ATTRIBUTES,
	SidebarChatBulkDeleteDialog,
} from "./sidebar-chat-selection.tsx";
import { ChatRow, SidebarSideChats } from "./sidebar-conversation-rows.tsx";
import { SidebarMoreUnreads } from "./sidebar-more-unreads.tsx";
// The section vocabulary (built-in keys + labels + glyphs) and the order
// persistence/reconciliation that goes with it. Kept in its own module so the
// part that must never lose a user's saved layout is unit-testable without a DOM.
import { SECTION_LABELS, type SectionKey } from "./sidebar-sections.ts";

export { MessagingAgentRowBody } from "./sidebar-agent-rows.tsx";
export { AgentThreadList } from "./sidebar-agents-section.tsx";
export { BotModeChatSectionsBody } from "./sidebar-bot-chat-sections.tsx";
export { SidebarChatList } from "./sidebar-chat-list.tsx";
export { ChatsSection } from "./sidebar-chats-section.tsx";
export { SidebarConversationList } from "./sidebar-conversation-list.tsx";
export { DynamicSidebarSection } from "./sidebar-dynamic-section.tsx";
export type { ChromeKey, DynamicChromeKey } from "./sidebar-panel-state.tsx";
export { SpaceScopeMenu } from "./sidebar-scope-menus.tsx";
export { SidebarScopePicker } from "./sidebar-scope-picker.tsx";
export { SectionOverflowPopover } from "./sidebar-section-overflow.tsx";
// Re-exported so the sidebar stays the single import surface for its own types
// (CustomizeSidebarDialog and friends import them from here, not from the
// vocabulary module).
export type {
	DynamicSectionKey,
	SectionKey,
} from "./sidebar-sections.ts";
export { SpacesPickerBody } from "./sidebar-space-picker.tsx";
export { SpaceSidebarRow } from "./sidebar-space-row.tsx";
export { SubSection } from "./sidebar-subsection.tsx";
export { ChatRow, SidebarSideChats };

interface AppSidebarProps {
	activeConversationId?: string | null;
	onDeleteConversation?: (id: string) => void;
	onNewConversation?: () => void;
	onOpenQuickPreview?: (id: string) => void;
	onOpenQuickReply?: (id: string) => void;
	onSelectConversation?: (id: string) => void;
}

/** Shared panel content — rendered inside either the docked Sidebar or the floating overlay. */
export const SidebarPanelContent = memo(function SidebarPanelContent({
	activeConversationId = null,
	onSelectConversation,
	onNewConversation,
	onDeleteConversation,
	onOpenQuickPreview,
	onOpenQuickReply,
}: AppSidebarProps) {
	const productMode = useProductMode();
	const { t } = useI18n();
	const botProduct = productMode === "bot";
	const listRef = useRef<HTMLDivElement | null>(null);
	const { conversations, setConversationVisibility, refresh } =
		useChatHistoryContext();
	const { canMakePrivate } = useVisibilityAdminAccess();
	const openTab = useTabSelector((state) => state.openTab);
	const activeNode = useActiveNode();
	const { canSwitchToConsole } = useConsoleAccess(activeNode);
	const { agents } = useAgents();
	// Plugin enabled-state, used to hide a plugin-owned section (Meetings/Spaces)
	// whose App the user disabled — its routes 503, so the nav entry would lead to
	// a dead page. `SECTION_PLUGIN_OWNER` names the two Core gates on.
	const { apps: pluginApps } = useApps();
	// The "import a past agent thread" dialog, shared by the Chats header button
	// and (when enabled) fed continuously by the background auto-importer below.
	const [importOpen, setImportOpen] = useState(false);
	const [setupImportOpen, setSetupImportOpen] = useState(false);
	const {
		changingChatVisibility,
		confirmConversationVisibility,
		pendingChatVisibility,
		requestConversationVisibility,
		setPendingChatVisibility,
	} = useConversationVisibilityRequest(
		canMakePrivate,
		setConversationVisibility
	);
	const [scheduledConversationId, setScheduledConversationId] = useState<
		string | null
	>(null);
	const importTarget = useSidebarAutoImport({ activeNode, agents, refresh });
	// Drives whether the "Tabs" section renders (vertical layout) or is skipped
	// (horizontal layout, where the title-bar strip owns the tabs).
	const tabLayout = useTabLayout();
	const notificationLayout = useNotificationLayout();
	// App-registered sidebar sections from the contributions feed. Namespaced keys
	// (`plugin:<pluginId>:<sectionId>`) that render via DynamicSidebarSection and are
	// appended to the persisted order (see `effectiveOrder`). Empty when no enabled
	// app contributes one, so this is inert until a fixture declares a section.
	const {
		chat_features: chatFeatures,
		sidebar_sections: contributedSections,
		sidebar_buttons: contributedButtons,
	} = usePluginContributions();
	const coreAppIds = useMemo(
		() =>
			new Set(
				pluginApps.filter((app) => isCoreAppTier(app.tier)).map((app) => app.id)
			),
		[pluginApps]
	);
	const sideChatsEnabled = hasPluginChatFeature(
		chatFeatures,
		SIDE_CHATS_PLUGIN_ID,
		SIDE_CHAT_FEATURE_KIND
	);
	const {
		activeMode,
		activeTabbedSection,
		dynamicSectionKeys,
		setActiveTabbedSection,
		setSidebarMode,
		sidebarModes,
	} = useSidebarPanelMode({ botProduct, contributedSections });
	const layout = useSidebarLayout({
		activeMode,
		botProduct,
		contributedButtons,
		coreAppIds,
		dynamicSectionKeys,
	});
	const {
		chromeDnd,
		chromeMenu,
		handleCollapseAll,
		handleExpandAll,
		handleResetSidebar,
		hiddenChrome,
		hiddenSections,
		renderChromeOrder,
		renderOrder,
		setChromeHidden,
		setCustomizeOpen,
	} = layout;
	const {
		agentModeOtherChats,
		archived,
		chatBulkActions,
		chatGrouping,
		chatRowHandlers,
		pinned,
		projectList,
		rest,
	} = useSidebarChatRows({
		activeConversationId,
		activeMode,
		activeNode,
		agents,
		canMakePrivate,
		onDeleteConversation,
		onOpenQuickPreview,
		onOpenQuickReply,
		onSelectConversation,
		pluginApps,
		requestConversationVisibility,
		setScheduledConversationId,
		sideChatsEnabled,
	});

	const handleNewConversation = () => {
		onNewConversation?.();
	};

	// Labels for every section in the customize dialog: the built-in set plus each
	// app-contributed section's own title (keyed by its `plugin:<id>:<sectionId>`
	// key), so a contributed row reads as "Canvas", not the raw namespaced key.
	const sectionLabels = Object.fromEntries(
		Object.entries(SECTION_LABELS).map(([key, label]): [string, string] => [
			key,
			t(`sidebar.section.${key}`, {}, label),
		])
	);
	for (const section of contributedSections) {
		sectionLabels[`plugin:${section.plugin}:${section.id}`] = section.title;
	}

	const renderSection = (key: SectionKey, forceExpanded = false) =>
		renderSidebarSection(key, forceExpanded, {
			...layout,
			activeMode,
			agentModeOtherChats,
			archived,
			botProduct,
			chatRowHandlers,
			contributedSections,
			handleNewConversation,
			onOpenQuickPreview,
			onOpenQuickReply,
			pinned,
			pluginApps,
			projectList,
			rest,
			setImportOpen,
			setSetupImportOpen,
			tabLayout,
		});

	const { activeTabbedKey, sectionNavItems, tabbedKeys } =
		resolveTabbedSections({
			activeMode,
			activeTabbedSection,
			hiddenSections,
			renderOrder,
			sectionLabels,
			tabLayout,
		});

	return (
		<ChatGroupingContext.Provider value={chatGrouping}>
			<SidebarSectionNav items={sectionNavItems} />
			<SidebarPanelHeader
				activeMode={activeMode}
				activeTabbedKey={activeTabbedKey}
				botProduct={botProduct}
				canSwitchToConsole={canSwitchToConsole}
				chromeDnd={chromeDnd}
				chromeMenu={chromeMenu}
				contributedButtons={contributedButtons}
				conversations={conversations}
				handleNewConversation={handleNewConversation}
				hiddenChrome={hiddenChrome}
				renderChromeOrder={renderChromeOrder}
				sectionLabels={sectionLabels}
				setActiveTabbedSection={setActiveTabbedSection}
				tabbedKeys={tabbedKeys}
			/>

			{/* Positioned wrapper so the "More unreads" pills can float over the
			    scrolling list without living inside it. */}
			<div className="relative flex min-h-0 flex-1 flex-col" ref={listRef}>
				<SidebarMoreUnreads containerRef={listRef} />
				{/* Right-clicking the sidebar background (not a row — each row's own
			    context menu stops propagation) opens the sidebar-wide menu. */}
				<ContextMenu>
					<ContextMenuTrigger
						render={
							// One shift-click range per panel: the docked and floating
							// sidebars can both be mounted.
							<SidebarContent
								{...SIDEBAR_CHAT_SCOPE_ATTRIBUTES}
								spacing="compact"
							/>
						}
					>
						{activeMode.layout === "stacked" ? (
							activeMode.key === "computers" ? (
								<AllComputersSidebar
									onNewChatOn={(node) =>
										openTab("/chat", { forceNew: true, node: node.name })
									}
									renderLocalSections={() =>
										renderOrder.map((key) => renderSection(key))
									}
								/>
							) : (
								renderOrder.map((key) => renderSection(key))
							)
						) : (
							activeTabbedKey && renderSection(activeTabbedKey, true)
						)}
					</ContextMenuTrigger>
					{!botProduct && (
						<SidebarRootContextMenuContent
							activeMode={activeMode}
							handleCollapseAll={handleCollapseAll}
							handleExpandAll={handleExpandAll}
							handleResetSidebar={handleResetSidebar}
							setCustomizeOpen={setCustomizeOpen}
							setSidebarMode={setSidebarMode}
							sidebarModes={sidebarModes}
						/>
					)}
				</ContextMenu>
			</div>
			<ResourceVisibilityConfirmationDialog
				canMakePrivate={canMakePrivate}
				changing={changingChatVisibility}
				onConfirm={() => {
					confirmConversationVisibility().catch(() => undefined);
				}}
				onOpenChange={(open) => {
					if (!(open || changingChatVisibility)) {
						setPendingChatVisibility(null);
					}
				}}
				request={pendingChatVisibility}
			/>

			{/* Ongoing work (agent runs, downloads, approvals, recording, app-contributed
			    activities) pinned above the announcements block. Self-hides when
			    nothing is live. */}
			{!botProduct && <LiveActivitiesSection />}

			{/* Admin-authored announcements, pinned just above the account footer
			    (outside the scroll/reorder area). Self-hides when the feed is empty;
			    toggleable via the Customize dialog's "Bottom buttons" group. */}
			{!botProduct &&
				notificationLayout === "split" &&
				!hiddenChrome.has("announcements") && <AnnouncementsSection />}

			<SidebarFooter>
				<NavUser
					hiddenChrome={hiddenChrome}
					notificationLayout={notificationLayout}
					onHideChrome={(key) => setChromeHidden(key, true)}
				/>
			</SidebarFooter>

			{!botProduct && (
				<SidebarCustomizeDialog
					{...layout}
					contributedButtons={contributedButtons}
					sectionLabels={sectionLabels}
				/>
			)}
			<NewAutomationDialog
				defaultAgentId={
					conversations.find((item) => item.id === scheduledConversationId)
						?.agentId ?? undefined
				}
				defaultConversationId={scheduledConversationId ?? undefined}
				key={scheduledConversationId ?? "closed-scheduled-chat"}
				onCreated={() => setScheduledConversationId(null)}
				onOpenChange={(open) => {
					if (!open) {
						setScheduledConversationId(null);
					}
				}}
				open={scheduledConversationId !== null}
			/>
			<SidebarChatBulkDeleteDialog onDelete={chatBulkActions.deleteMany} />
			<ImportThreadsDialog
				agents={agents}
				onImported={(conversationId) => {
					refresh();
					openTab("/chat", { conversationId });
				}}
				onOpenChange={setImportOpen}
				open={importOpen}
				target={importTarget}
			/>
			<ImportSetupDialog
				onImported={() => {
					refresh();
				}}
				onOpenChange={setSetupImportOpen}
				open={setupImportOpen}
				target={importTarget}
			/>
			{/* NodeSelector normally mounts this shared dialog. Keep the Agents
			    section's New agent action live when the user hides that chrome. */}
			{hiddenChrome.has("node-selector") ? <CreateAgentDialog /> : null}
		</ChatGroupingContext.Provider>
	);
});

export const AppSidebar = memo(function AppSidebar({
	activeConversationId = null,
	onSelectConversation,
	onNewConversation,
	onDeleteConversation,
	onOpenQuickPreview,
	onOpenQuickReply,
}: AppSidebarProps) {
	const [sidebarVariant] = useSidebarVariant();
	return (
		<Sidebar data-sidebar-preview-boundary="" variant={sidebarVariant}>
			<SidebarPanelContent
				activeConversationId={activeConversationId}
				onDeleteConversation={onDeleteConversation}
				onNewConversation={onNewConversation}
				onOpenQuickPreview={onOpenQuickPreview}
				onOpenQuickReply={onOpenQuickReply}
				onSelectConversation={onSelectConversation}
			/>
			<SidebarRail />
		</Sidebar>
	);
});
