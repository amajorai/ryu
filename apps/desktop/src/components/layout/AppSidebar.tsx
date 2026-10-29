import {
	Add01Icon,
	ArchiveRestoreIcon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	CpuIcon,
	LibraryIcon,
	PackageIcon,
	PackageOpenIcon,
	Share01Icon,
	SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { COMPUTE_SHARE_FLAG } from "@ryu/auth/lib/feature-flags";
import { useI18n } from "@ryu/i18n/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarRail,
} from "@ryu/ui/components/sidebar.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { TabsSubtle, TabsSubtleItem } from "@ryu/ui/components/tabs-subtle.tsx";
import { useReorderShift } from "@ryu/ui/hooks/use-reorder-shift.tsx";
import {
	type Dispatch,
	memo,
	type ReactNode,
	type SetStateAction,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { CreateAgentDialog } from "@/src/components/agents/CreateAgentDialog.tsx";
import { NewAutomationDialog } from "@/src/components/calendar/NewAutomationDialog.tsx";
import { ImportSetupDialog } from "@/src/components/chat/ImportSetupDialog.tsx";
import { ImportThreadsDialog } from "@/src/components/chat/ImportThreadsDialog.tsx";
import { ResourceVisibilityConfirmationDialog } from "@/src/components/layout/ResourceVisibilityConfirmationDialog.tsx";
import { LiveActivitiesSection } from "@/src/components/live/LiveActivitiesSection.tsx";
import { NodeSelector } from "@/src/components/shell/NodeSelector.tsx";
import {
	useChatHistoryContext,
	useRunningMainThreadIds,
} from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { APPROVALS_ALIAS } from "@/src/contributions/companion-alias.ts";
import { useCompanionAlias } from "@/src/contributions/use-companion-alias.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	setAgentRowStyle,
	useAgentRowStylePref,
} from "@/src/hooks/useAgentRowStyle.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { useAutoSetupImport } from "@/src/hooks/useAutoSetupImport.ts";
import { useAutoThreadImport } from "@/src/hooks/useAutoThreadImport.ts";
import { useBotChatSections } from "@/src/hooks/useBotChatSections.ts";
import { useChatDateGrouping } from "@/src/hooks/useChatDateGrouping.ts";
import { useConsoleAccess } from "@/src/hooks/useConsoleAccess.ts";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { useSidebarChatPreview } from "@/src/hooks/useSidebarChatPreview.ts";
import { useSidebarGroupedNav } from "@/src/hooks/useSidebarGroupedNav.ts";
import {
	DEFAULT_SIDEBAR_MODE,
	sidebarModeSchema,
	useSidebarMode,
} from "@/src/hooks/useSidebarMode.ts";
import { useSidebarModes } from "@/src/hooks/useSidebarModes.ts";
import { useSidebarVariant } from "@/src/hooks/useSidebarVariant.ts";
import { setTabLayout, useTabLayout } from "@/src/hooks/useTabLayout.ts";
import { useVisibilityAdminAccess } from "@/src/hooks/useVisibilityAdminAccess.ts";
import { conversationsForOtherChats } from "@/src/lib/agent-conversation-groups.ts";
import type { BtwEntry } from "@/src/lib/api/btw.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { isCoreAppTier } from "@/src/lib/api/plugins.ts";
import {
	DEFAULT_HIDDEN_CHROME,
	DEFAULT_HIDDEN_SECTIONS,
	FEATURES_CHANGED_EVENT,
	loadHiddenChrome,
	loadHiddenSections,
	persistHiddenChrome,
	persistHiddenSections,
	SECTION_HIDDEN_KEY,
} from "@/src/lib/features.ts";
import { dedupeFolders, folderKey, sameFolder } from "@/src/lib/folder-path.ts";
import { useNotificationLayout } from "@/src/lib/notification-layout.ts";
import {
	hasPluginChatFeature,
	SIDE_CHAT_FEATURE_KIND,
	SIDE_CHATS_PLUGIN_ID,
} from "@/src/lib/plugin-chat-features.ts";
import { isRyuBot } from "@/src/lib/product.ts";
import { useProductMode } from "@/src/lib/product-mode.ts";
import {
	resourceVisibilityForGroup,
	type VisibilityChangeRequest,
} from "@/src/lib/resource-visibility.ts";
import {
	conversationEntityKey,
	openEntityInNewWindow,
	routeEntityOpen,
} from "@/src/lib/window-routing.ts";
import {
	findWorkspaceProject,
	workspaceProjectName,
} from "@/src/lib/workspace-projects.ts";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import type { Conversation } from "@/types/chat.ts";
import { BotConnectionBadge } from "../bot/BotConnectionBadge.tsx";
import { BotProfileCard } from "../bot/BotProfileCard.tsx";
import { AllComputersSidebar } from "./AllComputersSidebar.tsx";
import { AnnouncementsSection } from "./AnnouncementsSection.tsx";
import {
	ContextMenuSectionHeading,
	SIDEBAR_OVERFLOW_POPOVER_KEY,
	SidebarListAppearanceMenuItems,
	TabLayoutMenuItems,
} from "./appearance-context-menu.tsx";
import { CustomizeSidebarDialog } from "./CustomizeSidebarDialog.tsx";
import { NavUser } from "./NavUser.tsx";
import { SidebarBrandBadge } from "./SidebarBrandBadge.tsx";
import { SidebarSectionNav } from "./SidebarSectionNav.tsx";
import { AgentsSection } from "./sidebar-agents-section.tsx";
import {
	ChatGroupingContext,
	type ChatGroupingValue,
} from "./sidebar-chat-grouping.tsx";
import {
	SIDEBAR_CHAT_SCOPE_ATTRIBUTES,
	type SidebarChatBulkActions,
	SidebarChatBulkDeleteDialog,
	type SidebarChatDropTarget,
	useSidebarChatSelectionEscape,
} from "./sidebar-chat-selection.tsx";
import {
	type ChatClassifyContext,
	type ChatSectionView,
	type ChatSectionViews,
	DEFAULT_CHAT_SECTION_VIEW,
} from "./sidebar-chat-view.ts";
import { ChatsSection } from "./sidebar-chats-section.tsx";
import {
	CheckedContextMenuItem,
	ChromeButtonShell,
	type ChromeDnd,
	ChromeHideMenu,
	type ChromeMenu,
	DynamicSidebarButton,
	NavTabButton,
	SidebarContextMenuItem,
} from "./sidebar-chrome-buttons.tsx";
import {
	ChannelsSection,
	IntegrationsSection,
} from "./sidebar-connection-sections.tsx";
import {
	groupByProject,
	type ProjectBucket,
} from "./sidebar-conversation-list.tsx";
import type { ChatRowHandlers } from "./sidebar-conversation-rows.tsx";
import { ChatRow, SidebarSideChats } from "./sidebar-conversation-rows.tsx";
import { DynamicSidebarSection } from "./sidebar-dynamic-section.tsx";
import {
	EnginesSection,
	PinnedSection,
} from "./sidebar-engines-pinned-sections.tsx";
import { AppsSection, PluginsSection } from "./sidebar-extension-sections.tsx";
import {
	IdentitiesSection,
	SkillsSection,
} from "./sidebar-identity-skill-sections.tsx";
import {
	AGENT_MODE_SECTIONS,
	orderedSidebarModeSections,
	resolveSidebarMode,
} from "./sidebar-modes.ts";
import { SidebarMoreUnreads } from "./sidebar-more-unreads.tsx";
import {
	CHROME_LABELS,
	CHROME_ORDER,
	type ChromeKey,
	COMPUTE_SHARE_CHROME,
	type DynamicChromeKey,
	FOOTER_CHROME,
	HEADER_BUTTON_CHROME,
	isChromeKey,
	isDynamicChromeKey,
	isHeaderButtonChrome,
	loadChromeOrder,
	loadIdSet,
	projectName,
	SECTION_COLLAPSED_KEY,
	SECTION_PAGE_SIZE_KEY,
	SECTION_PLUGIN_OWNER,
	SECTION_SORT_KEY,
	SECTION_TAB_ICONS,
	saveChromeOrder,
	saveIdSet,
} from "./sidebar-panel-state.tsx";
import {
	ArchivedSection,
	ProjectsSection,
} from "./sidebar-projects-section.tsx";
import {
	DEFAULT_PAGE_SIZE,
	loadPageSizes,
	savePageSizes,
} from "./sidebar-scope-picker.tsx";
import type {
	SectionDnd,
	SectionMenu,
	SectionProps,
} from "./sidebar-section.tsx";
// The section vocabulary (built-in keys + labels + glyphs) and the order
// persistence/reconciliation that goes with it. Kept in its own module so the
// part that must never lose a user's saved layout is unit-testable without a DOM.
import {
	DEFAULT_SECTION_ORDER,
	type DynamicSectionKey,
	isDynamicSectionKey,
	loadSectionOrder,
	migrateLegacySectionStorage,
	SECTION_ICONS,
	SECTION_LABELS,
	SECTION_ORDER_KEY,
	type SectionKey,
	saveSectionOrder,
} from "./sidebar-sections.ts";
import {
	CHAT_VIEW_SECTIONS,
	DEFAULT_SORT,
	loadChatSectionViews,
	loadSorts,
	type SortKey,
	saveChatSectionViews,
	saveSorts,
} from "./sidebar-sort-paging.ts";
import { SpacesSection } from "./sidebar-spaces-section.tsx";
import { TabsSection } from "./sidebar-tabs-section.tsx";
import { McpSection, ToolsSection } from "./sidebar-tool-sections.tsx";

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

/** The section selectors shown in "tabbed" mode — a single horizontal strip of
 *  tabs (TabsSubtle, "active label" mode: the selected tab shows its label, the
 *  rest collapse to their icon). The strip overflows to the right on a
 *  horizontal scroll when the sections don't fit, rather than wrapping. Clicking
 *  a tab reveals just that section's list below; labels follow the same
 *  (optionally customized) names as the stacked "sections" mode. */
function TabbedSectionNav({
	activeKey,
	keys,
	labels,
	onSelect,
}: {
	activeKey: SectionKey | null;
	keys: SectionKey[];
	labels: Record<string, string>;
	onSelect: (key: SectionKey) => void;
}) {
	if (keys.length === 0) {
		return null;
	}
	// Map the active section key to its index; default to the first tab so the
	// pill always has an anchor even before a selection lands.
	const selectedIndex = Math.max(0, activeKey ? keys.indexOf(activeKey) : 0);
	return (
		<div className="px-2 pt-1 pb-0.5">
			<TabsSubtle
				activeLabel
				aria-label="Sidebar sections"
				onSelect={(index) => {
					const key = keys[index];
					if (key) {
						onSelect(key);
					}
				}}
				selectedIndex={selectedIndex}
			>
				{keys.map((key, index) => (
					<TabsSubtleItem
						icon={
							Object.entries(SECTION_TAB_ICONS).find(
								([sectionKey]) => sectionKey === key
							)?.[1]
						}
						index={index}
						key={key}
						label={labels[key]}
					/>
				))}
			</TabsSubtle>
		</div>
	);
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
	const {
		listConversations,
		conversations,
		forkConversation,
		moveConversationToProject,
		removeConversationFromProject,
		autoRenameConversation,
		renameConversation,
		setConversationGlyph,
		setConversationVisibility,
		refresh,
		loadMessages,
	} = useChatHistoryContext();
	const { canMakePrivate } = useVisibilityAdminAccess();
	const openTab = useTabSelector((state) => state.openTab);
	const updateTabsIconWhere = useTabSelector(
		(state) => state.updateTabsIconWhere
	);
	const requestScrollToMessage = useTabSelector(
		(state) => state.requestScrollToMessage
	);
	const activeNode = useActiveNode();
	const { canSwitchToConsole } = useConsoleAccess(activeNode);
	const { agents } = useAgents();
	// Plugin enabled-state, used to hide a plugin-owned section (Meetings/Spaces)
	// whose App the user disabled — its routes 503, so the nav entry would lead to
	// a dead page. `SECTION_PLUGIN_OWNER` names the two Core gates on.
	const { apps: pluginApps } = useApps();
	const pullRequestsEnabled = pluginApps.some(
		(app) => app.id === "@ryu/pull-requests" && app.enabled
	);
	// The "import a past agent thread" dialog, shared by the Chats header button
	// and (when enabled) fed continuously by the background auto-importer below.
	const [importOpen, setImportOpen] = useState(false);
	const [setupImportOpen, setSetupImportOpen] = useState(false);
	const [pendingChatVisibility, setPendingChatVisibility] =
		useState<VisibilityChangeRequest | null>(null);
	const [changingChatVisibility, setChangingChatVisibility] = useState(false);
	const [scheduledConversationId, setScheduledConversationId] = useState<
		string | null
	>(null);
	const requestConversationVisibility = useCallback(
		(request: VisibilityChangeRequest) => {
			if (request.to === "private" && !canMakePrivate) {
				toast.error(
					"Only organization admins can make shared resources private"
				);
				return;
			}
			setPendingChatVisibility(request);
		},
		[canMakePrivate]
	);
	const confirmConversationVisibility = useCallback(async () => {
		if (!pendingChatVisibility) {
			return;
		}
		if (pendingChatVisibility.to === "private" && !canMakePrivate) {
			toast.error("Only organization admins can make shared resources private");
			return;
		}
		setChangingChatVisibility(true);
		try {
			const success = await setConversationVisibility(
				pendingChatVisibility.id,
				resourceVisibilityForGroup(pendingChatVisibility.to)
			);
			if (success) {
				setPendingChatVisibility(null);
				return;
			}
			toast.error("Couldn't change this chat's visibility", {
				description: "The chat stayed in its current group.",
			});
		} catch {
			toast.error("Couldn't change this chat's visibility", {
				description: "The chat stayed in its current group.",
			});
		} finally {
			setChangingChatVisibility(false);
		}
	}, [canMakePrivate, pendingChatVisibility, setConversationVisibility]);
	const importTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);
	// Background auto-import of agents' own on-disk threads, gated by the General
	// setting. Imports new threads into their workspace folders and refreshes the
	// conversation list so they appear grouped without a manual step.
	useAutoThreadImport({
		agents,
		target: importTarget,
		onImported: () => {
			refresh();
		},
	});
	// Background auto-import of setup *instructions* from the well-known agent
	// config roots, gated by the General setting (skills/MCP/plugins stay behind
	// the explicit review in the manual dialog).
	useAutoSetupImport({
		target: importTarget,
		onImported: () => {
			refresh();
		},
	});
	// The synced project list (shared with the composer's project picker): the
	// active folder, recent folders, and any removed-from-app folders.
	const workspaceFolder = useWorkspaceStore((s) => s.folder);
	const recentFolders = useWorkspaceStore((s) => s.recentFolders);
	const removedProjects = useWorkspaceStore((s) => s.removedProjects);
	const projectNames = useWorkspaceStore((s) => s.projectNames);
	const workspaceProjects = useWorkspaceStore((s) => s.projects);
	// Drives whether the "Tabs" section renders (vertical layout) or is skipped
	// (horizontal layout, where the title-bar strip owns the tabs).
	const tabLayout = useTabLayout();
	// The stored mode KEY; the arrangement it names is resolved below against the
	// modes on offer (built-in + contributed) — see `layout/sidebar-modes.ts`.
	const [sidebarMode, setSidebarMode] = useSidebarMode();
	const [sidebarVariant, setSidebarVariant] = useSidebarVariant();
	const [groupByDate, setGroupByDate] = useChatDateGrouping();
	const [groupedNav, setGroupedNav] = useSidebarGroupedNav();
	const [showSidebarChatPreview, setShowSidebarChatPreview] =
		useSidebarChatPreview();
	const [sidebarOverflowPopover, setSidebarOverflowPopover] =
		usePersistedToggle(SIDEBAR_OVERFLOW_POPOVER_KEY, false);
	const agentRowStyle = useAgentRowStylePref();
	const notificationLayout = useNotificationLayout();
	// Which section the tabbed bar currently reveals. Reconciled below against the
	// visible keys so it never points at a hidden/missing section.
	const [activeTabbedSection, setActiveTabbedSection] =
		useState<SectionKey | null>(null);
	// Changing mode drops the remembered tab. The reconciliation below only catches
	// a selection the new mode does NOT offer, and "chats" is offered by both — so
	// arriving in Bot mode from a Tabbed session parked on Chats would open on
	// Chats is offered by both modes, so arriving in Agents view from a full
	// sidebar must still land on the roster. Clearing lets each mode's own default
	// win.
	// reacting to the mode change itself, not to the setter.
	useEffect(() => {
		setActiveTabbedSection(null);
	}, [sidebarMode]);

	// Pin/archive/unread live in one module-level store (see
	// `useConversationFlagsStore`) because the tab context menus offer the same
	// rows; a second `useState` copy here would desync on the first toggle.
	const unreadIds = useConversationFlagsStore((s) => s.unreadIds);
	const pinnedIds = useConversationFlagsStore((s) => s.pinnedIds);
	const archivedIds = useConversationFlagsStore((s) => s.archivedIds);
	const observeMessageCounts = useConversationFlagsStore(
		(s) => s.observeMessageCounts
	);
	const mergeServerFlags = useConversationFlagsStore((s) => s.mergeServerFlags);
	const markRead = useConversationFlagsStore((s) => s.markRead);
	const markUnread = useConversationFlagsStore((s) => s.markUnread);
	const handleTogglePin = useConversationFlagsStore((s) => s.togglePin);
	const handleToggleArchive = useConversationFlagsStore((s) => s.toggleArchive);
	const [sectionOrder, setSectionOrder] = useState<SectionKey[]>(() => {
		migrateLegacySectionStorage(localStorage, {
			arrays: [SECTION_ORDER_KEY, SECTION_COLLAPSED_KEY, SECTION_HIDDEN_KEY],
			records: [SECTION_PAGE_SIZE_KEY, SECTION_SORT_KEY],
		});
		return loadSectionOrder();
	});
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
	// The arrangements on offer, shared with the Appearance tab so the two surfaces
	// cannot disagree about which contributed modes are real.
	const { modes: sidebarModes, settled: contributionsSettled } =
		useSidebarModes();
	const dynamicSectionKeys = useMemo<SectionKey[]>(
		() =>
			[...contributedSections]
				.sort(
					(a, b) =>
						(a.order ?? Number.MAX_SAFE_INTEGER) -
						(b.order ?? Number.MAX_SAFE_INTEGER)
				)
				.map((s): DynamicSectionKey => `plugin:${s.plugin}:${s.id}`),
		[contributedSections]
	);
	const resolvedSidebarMode = resolveSidebarMode(
		sidebarMode,
		sidebarModes,
		contributionsSettled
	);
	const activeMode: import("./sidebar-modes.ts").SidebarModeDescriptor =
		botProduct
			? {
					defaultSection: "chats",
					description: "Bot conversations",
					key: "bot",
					layout: "stacked" as const,
					sections: ["chats"],
					title: "Bot",
				}
			: resolvedSidebarMode.mode;
	const modeIsStale = botProduct ? false : resolvedSidebarMode.stale;
	// A stored mode whose app is gone is cleared, not merely fallen back from —
	// otherwise every render re-resolves a key that will never resolve again, and
	// re-enabling the app silently teleports the user back into its mode weeks
	// later. Only ever runs once per disappearance (the write changes `sidebarMode`).
	useEffect(() => {
		if (modeIsStale) {
			setSidebarMode(DEFAULT_SIDEBAR_MODE);
		}
	}, [modeIsStale, setSidebarMode]);
	const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
		() => {
			// Default the Archived section to collapsed on first run, so it stays out
			// of the way until the user opens it. Once they toggle anything, their
			// stored preference wins.
			const stored = localStorage.getItem(SECTION_COLLAPSED_KEY);
			return stored ? loadIdSet(SECTION_COLLAPSED_KEY) : new Set(["archived"]);
		}
	);
	const [draggingKey, setDraggingKey] = useState<SectionKey | null>(null);
	const [dragOverKey, setDragOverKey] = useState<SectionKey | null>(null);
	const sectionShift = useReorderShift({
		activeId: draggingKey,
		axis: "y",
		overId: dragOverKey,
	});
	const [hiddenSections, setHiddenSections] =
		useState<Set<string>>(loadHiddenSections);
	const [hiddenChrome, setHiddenChrome] = useState<Set<string>>(() =>
		loadHiddenChrome()
	);
	const [chromeOrder, setChromeOrder] = useState<ChromeKey[]>(loadChromeOrder);
	// "inbox" is the last built-in chrome key still owned by an APP (the approvals
	// app's tray, rendered in NavUser). NavUser hides the button itself when nothing
	// claims the path; the Customize dialog has to make the same call, or it offers a
	// "show Inbox" toggle whose only outcome is a tab reading "App not enabled".
	const inboxOwner = useCompanionAlias(APPROVALS_ALIAS);
	// Plugin-registered header buttons (`sidebar_buttons`), appended to the persisted
	// chrome order the same way dynamic sections are. Core-tier App buttons are
	// deliberately excluded; their single entry belongs in the Apps shelf.
	const dynamicChromeKeys = useMemo<ChromeKey[]>(
		() =>
			[...contributedButtons]
				.filter((button) => !coreAppIds.has(button.plugin))
				.sort(
					(a, b) =>
						(a.order ?? Number.MAX_SAFE_INTEGER) -
						(b.order ?? Number.MAX_SAFE_INTEGER)
				)
				.map((b): DynamicChromeKey => `plugin:${b.plugin}:${b.id}`),
		[contributedButtons, coreAppIds]
	);
	// Compute and Share are held behind a rollout flag. Dropping them here hides
	// both the buttons and their Customize rows while keeping the persisted order,
	// so they return in place when the flag turns on.
	const computeShareEnabled = useFeatureFlag(COMPUTE_SHARE_FLAG);
	const effectiveChromeOrder = useMemo<ChromeKey[]>(() => {
		// Drop stale app-button keys from older releases as well as currently absent
		// plugin buttons. The app shelf below is the only host-level app entry point.
		const current = chromeOrder.filter(
			(key) =>
				(computeShareEnabled || !COMPUTE_SHARE_CHROME.has(key)) &&
				(!isDynamicChromeKey(key) || dynamicChromeKeys.includes(key))
		);
		const missing = dynamicChromeKeys.filter((k) => !current.includes(k));
		return missing.length > 0 ? [...current, ...missing] : current;
	}, [chromeOrder, computeShareEnabled, dynamicChromeKeys]);
	const [chromeDraggingKey, setChromeDraggingKey] = useState<ChromeKey | null>(
		null
	);
	const [chromeDragOverKey, setChromeDragOverKey] = useState<ChromeKey | null>(
		null
	);
	const chromeShift = useReorderShift({
		activeId: chromeDraggingKey,
		axis: "y",
		overId: chromeDragOverKey,
	});
	const [sectionPageSizes, setSectionPageSizes] =
		useState<Partial<Record<SectionKey, number>>>(loadPageSizes);
	const [sectionSorts, setSectionSorts] =
		useState<Partial<Record<SectionKey, SortKey>>>(loadSorts);
	const [chatSectionViews, setChatSectionViews] =
		useState<ChatSectionViews>(loadChatSectionViews);
	const [customizeOpen, setCustomizeOpen] = useState(false);
	useEffect(() => {
		observeMessageCounts(conversations, activeConversationId);
	}, [conversations, activeConversationId, observeMessageCounts]);

	// Merge server-backed pin/archive state (the same columns coordinator threads
	// write) into the localStorage-seeded sets. Union, not replace: existing local
	// pins are preserved (no destructive un-pin), and a conversation pinned by a
	// coordinator or another client shows up here. Going forward, toggles
	// write-through to Core so the two stay consistent.
	useEffect(() => {
		mergeServerFlags({
			pinned: conversations.filter((c) => c.pinned).map((c) => c.id),
			archived: conversations.filter((c) => c.archived).map((c) => c.id),
		});
	}, [conversations, mergeServerFlags]);

	// Re-sync hidden sections/chrome when another surface (Settings → Features,
	// the onboarding features step, or another window) changes them.
	useEffect(() => {
		const resync = () => {
			setHiddenSections(loadHiddenSections());
			setHiddenChrome(loadHiddenChrome());
		};
		window.addEventListener(FEATURES_CHANGED_EVENT, resync);
		window.addEventListener("storage", resync);
		return () => {
			window.removeEventListener(FEATURES_CHANGED_EVENT, resync);
			window.removeEventListener("storage", resync);
		};
	}, []);

	const toggleInSet = (
		setter: Dispatch<SetStateAction<Set<string>>>,
		key: string,
		id: string
	) => {
		setter((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			saveIdSet(key, next);
			return next;
		});
	};

	const handleToggleSection = (key: SectionKey) =>
		toggleInSet(setCollapsedSections, SECTION_COLLAPSED_KEY, key);

	const openConversation = async (
		id: string,
		activation?: { messageId?: string }
	) => {
		markRead(id);
		const action = await routeEntityOpen(conversationEntityKey(id), activation);
		if (action === "focused") {
			return action;
		}
		onSelectConversation?.(id);
		const conv = conversations.find((c) => c.id === id);
		openTab("/chat", {
			conversationId: id,
			title: conv?.title,
			icon: conv?.icon ?? null,
		});
		return action;
	};

	const handleSelectConversation = (id: string) => {
		void openConversation(id);
	};

	const handleJumpToMessage = (conversationId: string, messageId: string) => {
		void openConversation(conversationId, { messageId }).then((action) => {
			if (action === "focused") {
				return;
			}
			requestScrollToMessage(conversationId, messageId);
			window.dispatchEvent(
				new CustomEvent("ryu:scroll-to-message", {
					detail: { messageId },
				})
			);
		});
	};

	// Open a persisted side chat from the sidebar: bring its thread into focus,
	// then hand the entry to that thread's ChatPage (it surfaces it in the btw
	// overlay). Decoupled via a window event so the sidebar never reaches into
	// chat state directly — same pattern as the run-notification click.
	const handleOpenSideChat = (conversationId: string, entry: BtwEntry) => {
		void openConversation(conversationId).then((action) => {
			if (action === "focused") {
				return;
			}
			window.dispatchEvent(
				new CustomEvent("ryu:open-side-chat", {
					detail: { conversationId, entry },
				})
			);
		});
	};

	const handleOpenNewSideChat = (conversationId: string) => {
		handleSelectConversation(conversationId);
		window.dispatchEvent(
			new CustomEvent("ryu:open-side-chat", {
				detail: { conversationId },
			})
		);
	};

	const handleOpenConversationInNewTab = (id: string) => {
		markRead(id);
		const conv = conversations.find((c) => c.id === id);
		openTab("/chat", {
			conversationId: id,
			forceNew: true,
			title: conv?.title,
			icon: conv?.icon ?? null,
		});
	};

	const handleOpenConversationInNewWindow = (id: string) => {
		markRead(id);
		const conversation = conversations.find((item) => item.id === id);
		void openEntityInNewWindow({
			conversationId: id,
			node: activeNode.name,
			path: "/chat",
			title: conversation?.title,
		});
	};

	const handleForkConversation: ChatRowHandlers["onForkConversation"] = (
		id,
		destination
	) => {
		void forkConversation(id)
			.then((newId) => {
				if (!newId) {
					throw new Error("fork failed");
				}
				openTab("/chat", {
					conversationId: newId,
					forceNew: true,
					worktreeMode: destination === "worktree",
				});
				toast.success("Chat forked");
			})
			.catch(() => {
				toast.error("Couldn't fork this chat");
			});
	};

	const handleRemoveFromProject = (id: string) => {
		void removeConversationFromProject(id).then((success) => {
			if (success) {
				toast.success("Chat removed from project");
				return;
			}
			toast.error("Couldn't remove this chat from the project");
		});
	};

	/** The folder that stands for `folderPath`'s project, as the Projects section
	 *  buckets it: a multi-folder workspace project's first folder. */
	const projectFolderFor = (folderPath: string) =>
		findWorkspaceProject(workspaceProjects, folderPath)?.folders[0] ??
		folderPath;

	const handleMoveToProject = (id: string, path: string) => {
		const name = projectNameForFolder(path);
		void moveConversationToProject(id, path).then((success) => {
			if (success) {
				toast.success(`Chat moved to ${name}`);
				return;
			}
			toast.error(`Couldn't move this chat to ${name}`);
		});
	};

	const projectNameForFolder = (folderPath: string) => {
		const project = findWorkspaceProject(workspaceProjects, folderPath);
		if (project) {
			return workspaceProjectName(project, projectNames);
		}
		const trimmed = folderPath.replace(/[\\/]+$/, "");
		return trimmed.split(/[\\/]/).at(-1) ?? "project";
	};
	// Archived chats drop into a collapsed bucket (still reachable, so they can be
	// unarchived); pinned chats float to a dedicated section above Chats. The
	// remaining (non-pinned, non-archived) chats group by their workspace folder
	// (loose chats keep no folder), feeding the single nested Projects section.
	const allConversations = listConversations();
	const archived = allConversations.filter((c) => archivedIds.has(c.id));
	const visible = allConversations.filter((c) => !archivedIds.has(c.id));
	const pinned = visible.filter((c) => pinnedIds.has(c.id));
	const rest = visible.filter((c) => !pinnedIds.has(c.id));
	const { projects, loose } = groupByProject(rest, workspaceProjects);

	// The project list shown in the sidebar is the synced union of the composer's
	// recent folders and the folders of existing conversations (durable Core data),
	// minus any folders the user removed from the app. Folders with no chats still
	// appear (rendering a "No chats" hint). Chats whose folder was removed fall back
	// into the loose Chats section so no conversation is hidden.
	// Every one of these three sources spells the same directory its own way, so
	// the union, the removed-set and the bucket lookup all compare by `folderKey`.
	// Keyed on the raw string, `~/x` and `~/x/` were two folders with one name.
	const bucketByPath = new Map(projects.map((p) => [folderKey(p.path), p]));
	const removedSet = new Set(removedProjects.map(folderKey));
	const workspaceProjectByFolder = new Map(
		workspaceProjects.flatMap((project) =>
			project.folders.map((path) => [folderKey(path), project] as const)
		)
	);
	const projectPaths = dedupeFolders(
		[
			...(workspaceFolder ? [workspaceFolder] : []),
			...recentFolders,
			...projects.map((p) => p.path),
		].map(
			(path) =>
				workspaceProjectByFolder.get(folderKey(path))?.folders[0] ?? path
		)
	).filter((path) => !removedSet.has(folderKey(path)));
	const projectList: ProjectBucket[] = projectPaths.map((path) => {
		const existing = bucketByPath.get(folderKey(path));
		const workspaceProject = workspaceProjectByFolder.get(folderKey(path));
		const name = workspaceProject
			? workspaceProjectName(workspaceProject, projectNames)
			: projectName(path, projectNames);
		if (existing) {
			return existing.name === name ? existing : { ...existing, name };
		}
		return {
			conversations: [],
			name,
			path,
			sourceFolders: workspaceProject?.folders ?? [path],
		};
	});
	const looseChats: Conversation[] = [
		...loose,
		...projects
			.filter((p) => removedSet.has(folderKey(p.path)))
			.flatMap((p) => p.conversations),
	];
	const knownAgentIds = new Set(agents.map((agent) => agent.id));
	// Direct conversations are already rendered under their bot in the focused
	// Agents view. Keep group chats and rows whose agent is missing from the
	// roster in the fallback list so removing the old tab never hides a thread.
	const agentModeOtherChats =
		activeMode.key === "agent"
			? conversationsForOtherChats(rest, knownAgentIds)
			: looseChats;

	// Projects now live nested under the single Projects section, so the rendered
	// order is just the persisted built-in order (loadSectionOrder already drops any
	// stale per-project keys from older versions and splices in "projects").
	// The persisted built-in order, plus any app-contributed dynamic sections not yet
	// in it (appended in `order` order). A dynamic key the user has already arranged
	// stays in its stored position (loadSectionOrder preserves `plugin:` keys).
	const effectiveOrder: SectionKey[] = useMemo(() => {
		const missing = dynamicSectionKeys.filter((k) => !sectionOrder.includes(k));
		return missing.length > 0 ? [...sectionOrder, ...missing] : sectionOrder;
	}, [sectionOrder, dynamicSectionKeys]);
	const liveDynamicKeys = useMemo(
		() => new Set(dynamicSectionKeys),
		[dynamicSectionKeys]
	);
	const renderOrder: SectionKey[] = botProduct
		? ["chats"]
		: activeMode.key === "agent"
			? AGENT_MODE_SECTIONS
			: activeMode.key === "computers"
				? orderedSidebarModeSections(activeMode, effectiveOrder)
				: effectiveOrder.filter(
						(key) => !isDynamicSectionKey(key) || liveDynamicKeys.has(key)
					);
	const renderChromeOrder: ChromeKey[] = botProduct
		? ["new-chat"]
		: effectiveChromeOrder.filter((key) => !hiddenChrome.has(key));

	// The single writer for section order: every reorder path (drag, the per-section
	// move-up/down menu, and the customize dialog) funnels through here so they can
	// never drift out of sync. Reorders persist the reconciled `effectiveOrder`, so
	// project positions bake into the stored order once the user arranges anything.
	const reorderSections = (next: SectionKey[]) => {
		setSectionOrder(next);
		saveSectionOrder(next);
	};

	// Move the dragged section next to where it was dropped. Dropping below the
	// original position inserts after the target (and above inserts before) so
	// every slot, including the last, is reachable.
	const handleDropSection = (target: SectionKey) => {
		if (draggingKey && draggingKey !== target) {
			const draggingDown =
				effectiveOrder.indexOf(draggingKey) < effectiveOrder.indexOf(target);
			const next = effectiveOrder.filter((k) => k !== draggingKey);
			const targetIdx = next.indexOf(target);
			next.splice(draggingDown ? targetIdx + 1 : targetIdx, 0, draggingKey);
			reorderSections(next);
		}
		setDraggingKey(null);
		setDragOverKey(null);
	};

	// Move/hide operate relative to the visible sections, so a move never swaps a
	// section with a hidden one (which would read as "nothing happened").
	const visibleSectionOrder = renderOrder.filter((k) => !hiddenSections.has(k));

	const canMoveSection = (key: SectionKey, dir: "up" | "down") => {
		const idx = visibleSectionOrder.indexOf(key);
		if (idx === -1) {
			return false;
		}
		return dir === "up" ? idx > 0 : idx < visibleSectionOrder.length - 1;
	};

	const handleMoveSection = (key: SectionKey, dir: "up" | "down") => {
		const idx = visibleSectionOrder.indexOf(key);
		const neighbor =
			dir === "up"
				? visibleSectionOrder[idx - 1]
				: visibleSectionOrder[idx + 1];
		if (!neighbor) {
			return;
		}
		const next = renderOrder.filter((k) => k !== key);
		const neighborIdx = next.indexOf(neighbor);
		next.splice(dir === "up" ? neighborIdx : neighborIdx + 1, 0, key);
		reorderSections(next);
	};

	const setSectionHidden = (key: SectionKey, hidden: boolean) => {
		// Load fresh so a concurrent writer (e.g. the Settings → Features tab open
		// at the same time) isn't clobbered by a stale snapshot; persist dispatches
		// the change event, which other surfaces re-sync from.
		const next = loadHiddenSections();
		if (hidden) {
			next.add(key);
		} else {
			next.delete(key);
		}
		setHiddenSections(next);
		persistHiddenSections(next);
	};

	const setSectionsHidden = (keys: SectionKey[], hidden: boolean) => {
		const next = loadHiddenSections();
		for (const key of keys) {
			if (hidden) {
				next.add(key);
			} else {
				next.delete(key);
			}
		}
		setHiddenSections(next);
		persistHiddenSections(next);
	};

	const handleSetPageSize = (key: SectionKey, size: number) => {
		setSectionPageSizes((prev) => {
			const next = { ...prev, [key]: size };
			savePageSizes(next);
			return next;
		});
	};

	const handleSetSort = (key: SectionKey, sort: SortKey) => {
		setSectionSorts((prev) => {
			const next = { ...prev, [key]: sort };
			saveSorts(next);
			return next;
		});
	};

	const handleSetChatView = (key: SectionKey, view: ChatSectionView) => {
		setChatSectionViews((prev) => {
			const next = { ...prev, [key]: view };
			saveChatSectionViews(next);
			return next;
		});
	};

	// Collapse/expand every section at once (the sidebar root context menu). Uses
	// the full effective order, so hidden sections fold too — harmless, and keeps
	// the stored set consistent when a section is later un-hidden.
	const handleCollapseAll = () => {
		setCollapsedSections(() => {
			const next = new Set<string>(effectiveOrder);
			saveIdSet(SECTION_COLLAPSED_KEY, next);
			return next;
		});
	};

	const handleExpandAll = () => {
		setCollapsedSections(() => {
			const next = new Set<string>();
			saveIdSet(SECTION_COLLAPSED_KEY, next);
			return next;
		});
	};

	const setChromeHidden = (key: ChromeKey, hidden: boolean) => {
		const next = loadHiddenChrome();
		if (hidden) {
			next.add(key);
		} else {
			next.delete(key);
		}
		setHiddenChrome(next);
		persistHiddenChrome(next);
	};

	const setChromeItemsHidden = (keys: ChromeKey[], hidden: boolean) => {
		const next = loadHiddenChrome();
		for (const key of keys) {
			if (hidden) {
				next.add(key);
			} else {
				next.delete(key);
			}
		}
		setHiddenChrome(next);
		persistHiddenChrome(next);
	};

	// The single writer for header-button order: drag, the per-button move menu,
	// and the customize dialog all funnel through here, mirroring reorderSections.
	const reorderChrome = (next: ChromeKey[]) => {
		setChromeOrder(next);
		saveChromeOrder(next);
	};

	const handleDropChrome = (target: ChromeKey) => {
		if (chromeDraggingKey && chromeDraggingKey !== target) {
			const draggingDown =
				chromeOrder.indexOf(chromeDraggingKey) < chromeOrder.indexOf(target);
			const next = chromeOrder.filter((k) => k !== chromeDraggingKey);
			const targetIdx = next.indexOf(target);
			next.splice(
				draggingDown ? targetIdx + 1 : targetIdx,
				0,
				chromeDraggingKey
			);
			reorderChrome(next);
		}
		setChromeDraggingKey(null);
		setChromeDragOverKey(null);
	};

	// Move/hide operate relative to the *visible* buttons, so a move never swaps a
	// button with a hidden one (matching the section move behaviour).
	const visibleChromeOrder = chromeOrder.filter(
		(k) =>
			!hiddenChrome.has(k) &&
			(computeShareEnabled || !COMPUTE_SHARE_CHROME.has(k))
	);

	const canMoveChrome = (key: ChromeKey, dir: "up" | "down") => {
		const idx = visibleChromeOrder.indexOf(key);
		if (idx === -1) {
			return false;
		}
		return dir === "up" ? idx > 0 : idx < visibleChromeOrder.length - 1;
	};

	const handleMoveChrome = (key: ChromeKey, dir: "up" | "down") => {
		const idx = visibleChromeOrder.indexOf(key);
		const neighbor =
			dir === "up" ? visibleChromeOrder[idx - 1] : visibleChromeOrder[idx + 1];
		if (!neighbor) {
			return;
		}
		const next = chromeOrder.filter((k) => k !== key);
		const neighborIdx = next.indexOf(neighbor);
		next.splice(dir === "up" ? neighborIdx : neighborIdx + 1, 0, key);
		reorderChrome(next);
	};

	const chromeMenu: ChromeMenu = {
		canMove: canMoveChrome,
		onMove: handleMoveChrome,
		onHide: (key) => setChromeHidden(key, true),
	};

	const chromeDnd: ChromeDnd = {
		draggingKey: chromeDraggingKey,
		dragOverKey: chromeDragOverKey,
		order: chromeOrder,
		onDragStart: setChromeDraggingKey,
		onDragEnd: () => {
			setChromeDraggingKey(null);
			setChromeDragOverKey(null);
		},
		onDragOver: (key) =>
			setChromeDragOverKey((prev) => (prev === key ? prev : key)),
		// Drop on the resolved target, not the (shifted) button under the pointer.
		onDrop: (key) => handleDropChrome(chromeDragOverKey ?? key),
		shift: chromeShift,
	};

	const sectionMenu: SectionMenu = {
		canMove: canMoveSection,
		onMove: handleMoveSection,
		onHide: (key) => setSectionHidden(key, true),
		onSetChatView: handleSetChatView,
		onSetPageSize: handleSetPageSize,
		onSetSort: handleSetSort,
		onOpenCustomize: () => setCustomizeOpen(true),
	};

	// Reset the full sidebar layout: default order, no page caps, and only the
	// opt-in sections/chrome hidden — matching a fresh install rather than
	// revealing every optional surface.
	const handleResetSidebar = () => {
		reorderSections([...DEFAULT_SECTION_ORDER]);
		reorderChrome([...HEADER_BUTTON_CHROME]);
		const clearedHidden = new Set<string>(DEFAULT_HIDDEN_SECTIONS);
		setHiddenSections(clearedHidden);
		persistHiddenSections(clearedHidden);
		const clearedChromeHidden = new Set<string>(DEFAULT_HIDDEN_CHROME);
		setHiddenChrome(clearedChromeHidden);
		persistHiddenChrome(clearedChromeHidden);
		setSectionPageSizes(() => {
			const next: Partial<Record<SectionKey, number>> = {};
			savePageSizes(next);
			return next;
		});
		setSectionSorts(() => {
			const next: Partial<Record<SectionKey, SortKey>> = {};
			saveSorts(next);
			return next;
		});
		setChatSectionViews(() => {
			const next: ChatSectionViews = {};
			saveChatSectionViews(next);
			return next;
		});
	};

	const sectionDnd: SectionDnd = {
		draggingKey,
		dragOverKey,
		order: renderOrder,
		onDragStart: setDraggingKey,
		onDragEnd: () => {
			setDraggingKey(null);
			setDragOverKey(null);
		},
		onDragOver: (key) => setDragOverKey((prev) => (prev === key ? prev : key)),
		// Drop on the resolved target, not the (shifted) section under the pointer.
		onDrop: (key) => handleDropSection(dragOverKey ?? key),
		shift: sectionShift,
	};

	useSidebarChatSelectionEscape();
	const chatGroups = useBotChatSections();
	const runningMainThreadIds = useRunningMainThreadIds();
	const chatClassify = useMemo<ChatClassifyContext>(
		() => ({ runningIds: runningMainThreadIds, unreadIds }),
		[runningMainThreadIds, unreadIds]
	);
	const chatGrouping: ChatGroupingValue = {
		agents: agents.map((agent) => ({ id: agent.id, name: agent.name })),
		classify: chatClassify,
		groups: chatGroups,
		projectFolder: projectFolderFor,
		projectName: projectNameForFolder,
	};
	const conversationById = new Map(allConversations.map((c) => [c.id, c]));
	const existingChatIds = (ids: readonly string[]) =>
		ids.filter((id) => conversationById.has(id));
	const setChatsPinned = (ids: readonly string[], pinned: boolean) => {
		for (const id of existingChatIds(ids)) {
			if (pinnedIds.has(id) !== pinned) {
				handleTogglePin(id);
			}
		}
	};
	const setChatsArchived = (ids: readonly string[], archived: boolean) => {
		for (const id of existingChatIds(ids)) {
			if (archivedIds.has(id) !== archived) {
				handleToggleArchive(id);
			}
		}
	};
	const moveChatsToProject = (
		ids: readonly string[],
		folderPath: string | null
	) => {
		const moving = existingChatIds(ids).filter(
			(id) => (conversationById.get(id)?.folderPath || null) !== folderPath
		);
		if (moving.length === 0) {
			return;
		}
		void Promise.all(
			moving.map((id) => moveConversationToProject(id, folderPath))
		).then((results) => {
			const failed = results.filter((ok) => !ok).length;
			if (failed > 0) {
				toast.error(
					failed === 1
						? "Couldn't move a chat"
						: `Couldn't move ${failed} chats`
				);
				return;
			}
			const noun = moving.length === 1 ? "chat" : `${moving.length} chats`;
			toast.success(
				folderPath
					? `Moved ${noun} to ${projectNameForFolder(folderPath)}`
					: `Removed ${noun} from project`
			);
		});
	};
	/** Whether a chat's folder already belongs to a dropped-on project. */
	const inProjectFolders = (
		folderPath: string | null | undefined,
		target: { folderPath: string; sourceFolders: readonly string[] }
	) =>
		Boolean(folderPath) &&
		[target.folderPath, ...target.sourceFolders].some((folder) =>
			sameFolder(folder, folderPath ?? "")
		);
	// What landing in each section means. A drop makes the chat show up where it
	// was dropped: Pinned pins, Archived archives, Chats clears pin/archive and the
	// project folder, and a project files the chat under that folder.
	const chatNeedsMove = (id: string, target: SidebarChatDropTarget) => {
		const conversation = conversationById.get(id);
		if (!conversation) {
			return false;
		}
		const pinned = pinnedIds.has(id);
		const archived = archivedIds.has(id);
		switch (target.kind) {
			case "pinned":
				return archived || !pinned;
			case "archived":
				return !archived;
			case "chats":
				return pinned || archived || Boolean(conversation.folderPath);
			case "folder": {
				// Compare projects, not raw strings: a chat already in this project
				// (another spelling, or another folder of it) does not need a move.
				const current = conversation.folderPath || null;
				if (current === null || target.folderPath === null) {
					return current !== target.folderPath;
				}
				return !sameFolder(
					projectFolderFor(current),
					projectFolderFor(target.folderPath)
				);
			}
			case "project":
				return (
					pinned ||
					archived ||
					!inProjectFolders(conversation.folderPath, target)
				);
			default:
				return false;
		}
	};
	const moveChatsTo = (
		ids: readonly string[],
		target: SidebarChatDropTarget
	) => {
		const moving = ids.filter((id) => chatNeedsMove(id, target));
		switch (target.kind) {
			case "pinned":
				setChatsArchived(moving, false);
				setChatsPinned(moving, true);
				return;
			case "archived":
				setChatsArchived(moving, true);
				return;
			case "chats":
				setChatsArchived(moving, false);
				setChatsPinned(moving, false);
				moveChatsToProject(moving, null);
				return;
			case "folder":
				moveChatsToProject(moving, target.folderPath);
				return;
			case "project": {
				setChatsArchived(moving, false);
				setChatsPinned(moving, false);
				const refile = moving.filter(
					(id) =>
						!inProjectFolders(conversationById.get(id)?.folderPath, target)
				);
				moveChatsToProject(refile, target.folderPath);
				return;
			}
			default:
				return;
		}
	};
	const chatBulkActions: SidebarChatBulkActions = {
		deleteMany: (ids) => {
			for (const id of existingChatIds(ids)) {
				onDeleteConversation?.(id);
			}
		},
		dropTarget: (target) => ({
			accepts: (ids) => ids.some((id) => chatNeedsMove(id, target)),
			onDrop: (ids) => moveChatsTo(ids, target),
		}),
		moveToProject: moveChatsToProject,
		openInNewTabs: (ids) => {
			for (const id of existingChatIds(ids)) {
				handleOpenConversationInNewTab(id);
			}
		},
		projects: projectList.map((project) => ({
			label: projectNameForFolder(project.path),
			path: project.path,
		})),
		setArchived: setChatsArchived,
		setPinned: setChatsPinned,
		setRead: (ids, read) => {
			for (const id of existingChatIds(ids)) {
				if (read) {
					markRead(id);
				} else {
					markUnread(id);
				}
			}
		},
	};

	const chatRowHandlers: ChatRowHandlers = {
		activeConversationId,
		agents,
		archivedIds,
		bulk: chatBulkActions,
		pinnedIds,
		unreadIds,
		loadMessages,
		onAddScheduledTask: setScheduledConversationId,
		onDeleteConversation: onDeleteConversation ?? (() => undefined),
		onForkConversation: handleForkConversation,
		onJumpToMessage: handleJumpToMessage,
		onMarkRead: markRead,
		onMarkUnread: markUnread,
		onOpenQuickPreview,
		onOpenQuickReply: onOpenQuickReply ?? (() => undefined),
		onOpenInNewTab: handleOpenConversationInNewTab,
		onOpenInNewWindow: handleOpenConversationInNewWindow,
		onOpenNewSideChat: handleOpenNewSideChat,
		onOpenSideChat: handleOpenSideChat,
		onAutoRenameConversation: autoRenameConversation,
		onRenameConversation: renameConversation,
		onMoveToProject: handleMoveToProject,
		onRemoveFromProject: handleRemoveFromProject,
		onSelectConversation: handleSelectConversation,
		onSetConversationIcon: (id, icon) => {
			setConversationGlyph(id, icon);
			updateTabsIconWhere((t) => t.conversationId === id, icon);
		},
		onRequestConversationVisibility: requestConversationVisibility,
		onToggleArchive: handleToggleArchive,
		onTogglePin: handleTogglePin,
		projectNameForFolder,
		projectTargets: projectList,
		canMakePrivate,
		pullRequestsEnabled,
		schedulingEnabled: pluginApps.some(
			(app) => app.id === "@ryu/calendar" && app.enabled
		),
		target: toTarget(activeNode),
		sideChatsEnabled,
	};

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
	// Same idea for app-contributed header buttons (Memory, Home): the dialog's
	// "Top buttons" list needs their titles or the row shows the namespaced key.
	const chromeButtonLabels: Record<string, string> = {};
	for (const button of contributedButtons) {
		chromeButtonLabels[`plugin:${button.plugin}:${button.id}`] = button.title;
	}

	// One reorderable header button, by key. Returns the button's inner content;
	// ChromeButtonShell (below) supplies the draggable SidebarMenuItem wrapper.
	const renderHeaderButton = (key: ChromeKey): ReactNode => {
		switch (key) {
			case "new-chat":
				return (
					<ChromeHideMenu
						chromeKey="new-chat"
						label="New chat"
						menu={chromeMenu}
					>
						<SidebarMenuButton
							corners="rounded"
							onClick={handleNewConversation}
							size="compact"
						>
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							<span>{t("sidebar.chrome.new-chat", {}, "New chat")}</span>
						</SidebarMenuButton>
					</ChromeHideMenu>
				);
			// "search" now renders as an icon next to the node selector (see the
			// SidebarHeader row below), not as a header button.
			// "home" is represented by the owning app's Apps-shelf tile; no hardcoded
			// case. The key stays in BuiltinChromeKey/CHROME_LABELS for graceful
			// filtering of any stale persisted layout.
			case "library":
				return (
					<NavTabButton
						chromeKey="library"
						icon={LibraryIcon}
						label={t("sidebar.chrome.library", {}, "Library")}
						menu={chromeMenu}
						path="/library"
					/>
				);
			case "compute":
				return (
					<NavTabButton
						chromeKey="compute"
						icon={CpuIcon}
						label="Compute"
						menu={chromeMenu}
						path="/compute"
					/>
				);
			case "share":
				return (
					<NavTabButton
						chromeKey="share"
						icon={Share01Icon}
						label="Share"
						menu={chromeMenu}
						path="/share"
					/>
				);
			// "memory" is represented by the owning app's Apps-shelf tile. The key stays
			// in BuiltinChromeKey/CHROME_LABELS so a stale persisted layout is filtered
			// out gracefully rather than crashing.
			case "store":
				return (
					<NavTabButton
						activeIcon={PackageOpenIcon}
						chromeKey="store"
						icon={PackageIcon}
						label={t("sidebar.chrome.customize", {}, "Customize")}
						menu={chromeMenu}
						path="/store"
					/>
				);
			// "marketplace"/"apps"/"extensions" deliberately have NO case here, for the
			// reason given above CHROME_ORDER: all three folded into the Customize
			// (Store) shell as sections and no longer get their own sidebar button.
			// They kept unreachable cases for a while, which was worse than nothing —
			// `CHROME_ORDER` excludes the keys, so the cases could never run, and the
			// dead "marketplace" branch still rendered a storefront glyph while the
			// live Store button renders `PackageIcon`. A glyph that only exists on a
			// nothing reaches is a glyph nobody keeps in sync. The keys themselves stay
			// in BuiltinChromeKey/CHROME_LABELS so a stale persisted layout is filtered
			// gracefully; `default` returns null for them.
			// Tasks/Timeline/Activity/Calendar have no case here either: they are
			// Ryu Apps, listed by `AppsSection` from the enabled-companion feed. See
			// the note above CHROME_ORDER.
			default: {
				// Plugin-registered header button (`plugin:<pluginId>:<buttonId>`): resolve
				// the contribution from the feed and render it generically.
				if (isDynamicChromeKey(key)) {
					const button = contributedButtons.find(
						(b) => `plugin:${b.plugin}:${b.id}` === key
					);
					return button ? (
						<DynamicSidebarButton button={button} menu={chromeMenu} />
					) : null;
				}
				return null;
			}
		}
	};

	const renderSection = (key: SectionKey, forceExpanded = false) => {
		if (hiddenSections.has(key)) {
			return null;
		}
		// A plugin-owned section shows ONLY when its App is installed AND enabled.
		// Once the plugin list has loaded (`pluginApps` non-empty), an owner that is
		// absent (not installed — the not pre-installed apps) or disabled hides the section,
		// so Canvas/Whiteboard/Meetings don't render until their app is turned on.
		// While the list is still loading (empty) we show it, to never flicker a
		// working section away on a slow/failed /api/plugins fetch.
		const ownerPluginId = Object.entries(SECTION_PLUGIN_OWNER).find(
			([ownerKey]) => ownerKey === key
		)?.[1];
		if (ownerPluginId && pluginApps.length > 0) {
			const owner = pluginApps.find((a) => a.id === ownerPluginId);
			if (!owner?.enabled) {
				return null;
			}
		}
		const sectionProps: SectionProps = {
			chatView: CHAT_VIEW_SECTIONS.has(key)
				? (chatSectionViews[key] ?? DEFAULT_CHAT_SECTION_VIEW)
				: undefined,
			// In tabbed mode the selected section is always shown expanded — the bar,
			// not a collapse toggle, decides what's visible.
			collapsed: botProduct
				? false
				: forceExpanded
					? false
					: collapsedSections.has(key),
			dnd: sectionDnd,
			icon: isDynamicSectionKey(key) ? undefined : SECTION_ICONS[key],
			menu: sectionMenu,
			onOpenQuickPreview,
			onOpenQuickReply,
			pageSize: sectionPageSizes[key] ?? DEFAULT_PAGE_SIZE,
			sort: sectionSorts[key] ?? DEFAULT_SORT,
			onToggleCollapsed: handleToggleSection,
		};
		switch (key) {
			case "tabs":
				// The sidebar tab list only exists in vertical layout; every other view
				// owns its live tabs somewhere in the title bar or center pane.
				return tabLayout === "vertical" ? (
					<TabsSection key={key} {...sectionProps} />
				) : null;
			case "agents":
				return <AgentsSection key={key} {...sectionProps} />;
			case "spaces":
				return <SpacesSection key={key} {...sectionProps} />;
			// "meetings" is app-registered (@ryu/meetings `sidebar_sections`),
			// rendered via DynamicSidebarSection — no hardcoded case.
			case "channels":
				return <ChannelsSection key={key} {...sectionProps} />;
			case "integrations":
				return <IntegrationsSection key={key} {...sectionProps} />;
			case "identities":
				return <IdentitiesSection key={key} {...sectionProps} />;
			case "skills":
				return <SkillsSection key={key} {...sectionProps} />;
			case "mcp":
				return <McpSection key={key} {...sectionProps} />;
			case "tools":
				return <ToolsSection key={key} {...sectionProps} />;
			case "plugins":
				return <PluginsSection key={key} {...sectionProps} />;
			case "companions":
				return <AppsSection apps={pluginApps} key={key} {...sectionProps} />;
			case "engines":
				return <EnginesSection key={key} {...sectionProps} />;
			case "pinned":
				return (
					<PinnedSection
						key={key}
						{...sectionProps}
						handlers={chatRowHandlers}
						pinned={pinned}
					/>
				);
			case "projects":
				return (
					<ProjectsSection
						key={key}
						{...sectionProps}
						handlers={chatRowHandlers}
						projects={projectList}
					/>
				);
			case "chats":
				return (
					<ChatsSection
						botMode={botProduct || activeMode.key === "agent"}
						key={key}
						{...sectionProps}
						handlers={chatRowHandlers}
						loose={agentModeOtherChats}
						managedProduct={botProduct}
						onImport={botProduct ? undefined : () => setImportOpen(true)}
						onImportSetup={
							botProduct ? undefined : () => setSetupImportOpen(true)
						}
						onNew={handleNewConversation}
						sectionLabel={
							activeMode.key === "agent" ? "Projects & chats" : undefined
						}
						sessionSource={botProduct ? undefined : rest}
					/>
				);
			// canvas + whiteboard are app-registered (com.ryu.{canvas,whiteboard}
			// `sidebar_sections`, backed by /api/apps/<id>/docs), rendered via
			// DynamicSidebarSection — no hardcoded cases.
			case "archived":
				return (
					<ArchivedSection
						archived={archived}
						key={key}
						{...sectionProps}
						handlers={chatRowHandlers}
					/>
				);
			default: {
				// App-registered dynamic section (`plugin:<pluginId>:<sectionId>`):
				// resolve the contribution from the feed and render it generically.
				if (isDynamicSectionKey(key)) {
					const contribution = contributedSections.find(
						(s) => `plugin:${s.plugin}:${s.id}` === key
					);
					return contribution ? (
						<DynamicSidebarSection
							contribution={contribution}
							key={key}
							{...sectionProps}
						/>
					) : null;
				}
				return null;
			}
		}
	};

	// The section keys offered by the tabbed bar: every visible section, minus the
	// Tabs section when it would render nothing (horizontal tab layout owns tabs).
	const visibleTabbedKeys = renderOrder.filter(
		(key) =>
			!(hiddenSections.has(key) || (key === "tabs" && tabLayout !== "vertical"))
	);
	// A mode that NAMES sections narrows the strip to exactly those. Most modes
	// follow the user's own section order (so someone who dragged Chats above
	// Agents keeps that reading order); built-in Bot mode intentionally keeps its
	// declared Agents → Chats order. `hiddenSections` is deliberately NOT
	// applied to them: picking a mode is a more specific instruction than a
	// section hidden back when the sidebar listed fifteen of them.
	const tabbedKeys = activeMode.sections
		? orderedSidebarModeSections(activeMode, renderOrder)
		: visibleTabbedKeys;
	// Keep the remembered section pointed at a real, visible section. A mode's
	// declared `defaultSection` wins over "the first section" — Bot mode declares
	// Agents as both its first section and its default, so the roster is primary.
	const defaultTabbedKey =
		activeMode.defaultSection && tabbedKeys.includes(activeMode.defaultSection)
			? activeMode.defaultSection
			: (tabbedKeys[0] ?? null);
	const activeTabbedKey =
		activeTabbedSection && tabbedKeys.includes(activeTabbedSection)
			? activeTabbedSection
			: defaultTabbedKey;

	// The peek jump-list only makes sense in a stacked mode, where every visible
	// section is rendered (and thus has a scroll anchor). Under a tab strip only one
	// section exists at a time, so there's nothing to jump between. Agents view is
	// deliberately a single focused roster surface too; its direct threads are
	// already nested in the bot rows rather than behind another selector.
	const sectionNavItems =
		activeMode.layout === "stacked" && activeMode.key !== "agent"
			? visibleTabbedKeys.map((key) => ({
					key,
					label: sectionLabels[key] ?? key,
				}))
			: [];

	return (
		<ChatGroupingContext.Provider value={chatGrouping}>
			<SidebarSectionNav items={sectionNavItems} />
			<SidebarHeader spacing="flush">
				{botProduct ? (
					<BotConnectionBadge />
				) : (
					!hiddenChrome.has("node-selector") && (
						<div
							// pt-2 drops this row onto the top row's shared centerline (see
							// Layout): sidebar top pad 2 + pt-2 + h-8 centers the selector at
							// 30.72px — the tab strip's natural line (SidebarInset m-2 +
							// h-12/2), matched by the nav cluster and macOS traffic lights.
							className="flex items-center gap-2 px-2 pt-2 pb-1"
							data-tauri-drag-region
						>
							{/* Back/forward/sidebar-toggle/search live pinned at the window's
							    top-left (in Layout). The node selector is right-aligned here so
							    it never collides with that cluster. */}
							<div
								className="ml-auto flex items-center gap-0.5"
								data-tauri-drag-region={false}
							>
								<NodeSelector mode="compact-dropdown" />
							</div>
						</div>
					)
				)}
				{!hiddenChrome.has("logo") && (
					<SidebarBrandBadge
						canSwitchToConsole={canSwitchToConsole}
						canSwitchToOs={!isRyuBot()}
						className={hiddenChrome.has("node-selector") ? "pt-2" : ""}
					/>
				)}
				{botProduct ? <BotProfileCard conversations={conversations} /> : null}
				<div
					className="scroll-fade max-h-[min(50vh,28rem)] min-h-0 overflow-y-auto overscroll-contain"
					data-testid="sidebar-header-actions"
				>
					<SidebarMenu>
						{renderChromeOrder.map((key) => (
							<ChromeButtonShell chromeKey={key} dnd={chromeDnd} key={key}>
								{renderHeaderButton(key)}
							</ChromeButtonShell>
						))}
					</SidebarMenu>
				</div>
				{/* Every mode but the stacked one puts the section selectors below the
				    header button stack as a horizontal tab strip (not menu rows); the
				    chosen section's list shows in the scrollable content below. Which
				    sections are on the strip is the mode's business — see
				    `layout/sidebar-modes.ts`. */}
				{activeMode.layout === "strip" && (
					<TabbedSectionNav
						activeKey={activeTabbedKey}
						keys={tabbedKeys}
						labels={sectionLabels}
						onSelect={setActiveTabbedSection}
					/>
				)}
			</SidebarHeader>

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
						<ContextMenuContent>
							<ContextMenuSectionHeading>
								Sidebar mode
							</ContextMenuSectionHeading>
							{/* One row per mode on offer, built-in and contributed alike — the
					    menu has no idea which is which, which is the point. */}
							{sidebarModes.map((mode) => (
								<CheckedContextMenuItem
									checked={activeMode.key === mode.key}
									key={mode.key}
									onClick={() =>
										setSidebarMode(sidebarModeSchema.parse(mode.key))
									}
								>
									{mode.title}
								</CheckedContextMenuItem>
							))}
							<ContextMenuSeparator />
							<ContextMenuSectionHeading>
								Sidebar style
							</ContextMenuSectionHeading>
							<CheckedContextMenuItem
								checked={sidebarVariant === "floating"}
								onClick={() => setSidebarVariant("floating")}
							>
								Floating
							</CheckedContextMenuItem>
							<CheckedContextMenuItem
								checked={sidebarVariant === "inset"}
								onClick={() => setSidebarVariant("inset")}
							>
								Inset
							</CheckedContextMenuItem>
							<ContextMenuSeparator />
							<SidebarListAppearanceMenuItems
								activeModeKey={activeMode.key}
								agentRowStyle={agentRowStyle}
								groupByDate={groupByDate}
								groupedNav={groupedNav}
								setAgentRowStyle={setAgentRowStyle}
								setGroupByDate={setGroupByDate}
								setGroupedNav={setGroupedNav}
								setShowSidebarChatPreview={setShowSidebarChatPreview}
								setSidebarOverflowPopover={setSidebarOverflowPopover}
								showSidebarChatPreview={showSidebarChatPreview}
								sidebarOverflowPopover={sidebarOverflowPopover}
							/>
							<ContextMenuSeparator />
							<TabLayoutMenuItems onChange={setTabLayout} value={tabLayout} />
							<ContextMenuSeparator />
							<ContextMenuSectionHeading>Sections</ContextMenuSectionHeading>
							<SidebarContextMenuItem
								icon={ArrowDown01Icon}
								onClick={handleExpandAll}
							>
								Expand all sections
							</SidebarContextMenuItem>
							<SidebarContextMenuItem
								icon={ArrowUp01Icon}
								onClick={handleCollapseAll}
							>
								Collapse all sections
							</SidebarContextMenuItem>
							<ContextMenuSeparator />
							<ContextMenuSectionHeading>Customize</ContextMenuSectionHeading>
							<SidebarContextMenuItem
								icon={SlidersHorizontalIcon}
								onClick={() => setCustomizeOpen(true)}
							>
								Customize sidebar
							</SidebarContextMenuItem>
							<SidebarContextMenuItem
								icon={ArchiveRestoreIcon}
								onClick={handleResetSidebar}
							>
								Reset sidebar layout
							</SidebarContextMenuItem>
						</ContextMenuContent>
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
				<CustomizeSidebarDialog
					bottomChromeItems={CHROME_ORDER.filter(
						(key) =>
							FOOTER_CHROME.has(key) && (key !== "inbox" || inboxOwner !== null)
					).map((key) => ({
						key,
						label: t(
							`sidebar.chrome.${key}`,
							{},
							Object.entries(CHROME_LABELS).find(
								([chromeKey]) => chromeKey === key
							)?.[1] ?? key
						),
					}))}
					chromeHidden={hiddenChrome}
					fixedTopChromeItems={CHROME_ORDER.filter(
						(key) => !(FOOTER_CHROME.has(key) || isHeaderButtonChrome(key))
					).map((key) => ({
						key,
						label: t(
							`sidebar.chrome.${key}`,
							{},
							Object.entries(CHROME_LABELS).find(
								([chromeKey]) => chromeKey === key
							)?.[1] ?? key
						),
					}))}
					hidden={hiddenSections}
					labels={sectionLabels}
					onClose={() => setCustomizeOpen(false)}
					onReorder={reorderSections}
					onReorderChrome={reorderChrome}
					onReset={handleResetSidebar}
					onSetChromeItemsHidden={(keys, hidden) =>
						setChromeItemsHidden(keys.filter(isChromeKey), hidden)
					}
					onSetSectionsHidden={setSectionsHidden}
					onToggleChromeHidden={(key) =>
						isChromeKey(key) && setChromeHidden(key, !hiddenChrome.has(key))
					}
					onToggleHidden={(key) =>
						setSectionHidden(key, !hiddenSections.has(key))
					}
					open={customizeOpen}
					order={renderOrder}
					topButtonItems={effectiveChromeOrder.map((key) => ({
						key,
						label:
							chromeButtonLabels[key] ??
							(Object.entries(CHROME_LABELS).find(
								([chromeKey]) => chromeKey === key
							)?.[1]
								? t(
										`sidebar.chrome.${key}`,
										{},
										Object.entries(CHROME_LABELS).find(
											([chromeKey]) => chromeKey === key
										)?.[1]
									)
								: key),
					}))}
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
