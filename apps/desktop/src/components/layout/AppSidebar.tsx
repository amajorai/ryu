import {
	Add01Icon,
	ArchiveRestoreIcon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	ArrowUpRight01Icon,
	Cancel01Icon,
	ConnectIcon,
	DatabaseIcon,
	Delete01Icon,
	DeliverySecure01Icon,
	File01Icon,
	FileCodeIcon,
	FingerPrintIcon,
	Folder01Icon,
	Folder03Icon,
	FolderAddIcon,
	FolderOpenIcon,
	GitBranchIcon,
	GridIcon,
	Image01Icon,
	ImageAdd01Icon,
	LayerIcon,
	LibraryIcon,
	Mic01Icon,
	MoreHorizontalIcon,
	Package01Icon,
	PackageIcon,
	PackageOpenIcon,
	PencilEdit01Icon,
	PinIcon,
	PinOffIcon,
	PotionIcon,
	Search01Icon,
	ServerStack01Icon,
	Settings03Icon,
	SlidersHorizontalIcon,
	Tick02Icon,
	Tv01Icon,
	Upload01Icon,
	UserMultiple02Icon,
	ViewOffSlashIcon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	contributionSourceRequest,
	DECLARATIVE_HTTP_GRANT,
	isCoreReadPath,
	isViewSourceHttpMethod,
	normalizeViewRefreshMs,
	renderContributionActionHttp,
	renderTemplate,
	type SourceItem,
	sourceItemsFromResponse,
	type ViewActionHttp,
} from "@ryu/app-host/views";
import AppIcon from "@ryu/marketplace/catalog/chrome/app-icon";
import { iconCacheKey } from "@ryu/marketplace/catalog/icon-cache";
import { useOptionalReport } from "@ryu/marketplace/report";
import { AgentTitleBadge } from "@ryu/ui/components/agent-title-badge.tsx";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuRadioGroup,
	ContextMenuRadioItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { asGlyphValue, type GlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { Icon } from "@ryu/ui/components/icon.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
} from "@ryu/ui/components/sidebar.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import {
	type IconComponent,
	TabsSubtle,
	TabsSubtleItem,
} from "@ryu/ui/components/tabs-subtle.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type Dispatch,
	type DragEvent as ReactDragEvent,
	type ReactNode,
	type SetStateAction,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { UsageBar } from "@/components/agent-elements/input/usage-bar.tsx";
import { NewAutomationDialog } from "@/src/components/calendar/NewAutomationDialog.tsx";
import { AddChannelDialog } from "@/src/components/channels/AddChannelDialog.tsx";
import { ImportSetupDialog } from "@/src/components/chat/ImportSetupDialog.tsx";
import { ImportThreadsDialog } from "@/src/components/chat/ImportThreadsDialog.tsx";
import { NodeFolderBrowser } from "@/src/components/chat/NodeFolderBrowser.tsx";
import {
	CloneFolderDialog,
	CreateFolderDialog,
	ProjectPickerContent,
} from "@/src/components/chat/ProjectPicker.tsx";
import { AddIdentityDialog } from "@/src/components/identities/AddIdentityDialog.tsx";
import { EntityIconDialog } from "@/src/components/layout/EntityIconDialog.tsx";
import {
	OpenInNewWindowContextMenuItem,
	OpenInNewWindowDropdownMenuItem,
} from "@/src/components/layout/OpenInNewWindowMenuItem.tsx";
import {
	ProjectGlyph,
	ProjectIconDialog,
} from "@/src/components/layout/ProjectIconDialog.tsx";
import { ProjectSettingsDialog } from "@/src/components/layout/ProjectSettingsDialog.tsx";
import { ResourceVisibilityConfirmationDialog } from "@/src/components/layout/ResourceVisibilityConfirmationDialog.tsx";
import { ResourceVisibilityIndicator } from "@/src/components/layout/ResourceVisibilityIndicator.tsx";
import { SplitPresetMenuItems } from "@/src/components/layout/SplitPresetMenu.tsx";
import { NodeSelector } from "@/src/components/shell/NodeSelector.tsx";
import { AddToSpaceDialog } from "@/src/components/spaces/AddToSpaceDialog.tsx";
import { CreateSpaceDialog } from "@/src/components/spaces/CreateSpaceDialog.tsx";
import { RenameSpaceDialog } from "@/src/components/spaces/RenameSpaceDialog.tsx";
import { DestructiveConfirmDialog } from "@/src/components/ui/DestructiveConfirmDialog.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import type {
	Split,
	SplitOrientation,
	Tab,
} from "@/src/contexts/TabsContext.tsx";
import {
	findSplit,
	splitPaneTabs,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import { APPROVALS_ALIAS } from "@/src/contributions/companion-alias.ts";
import { parseContributedTarget } from "@/src/contributions/contributed-target.ts";
import { useCompanionAlias } from "@/src/contributions/use-companion-alias.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	setAgentRowStyle,
	useAgentRowStyle,
	useAgentRowStylePref,
} from "@/src/hooks/useAgentRowStyle.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { useAutoSetupImport } from "@/src/hooks/useAutoSetupImport.ts";
import { useAutoThreadImport } from "@/src/hooks/useAutoThreadImport.ts";
import {
	BOT_CHAT_SECTION_COLLAPSED_KEY,
	BOT_CHAT_SECTION_ORDER_KEY,
	useBotChatSections,
} from "@/src/hooks/useBotChatSections.ts";
import { useChannels } from "@/src/hooks/useChannels.ts";
import { useChatDateGrouping } from "@/src/hooks/useChatDateGrouping.ts";
import {
	useComposioConnections,
	useComposioStatus,
	useComposioToolkits,
} from "@/src/hooks/useComposioCatalog.ts";
import { useConsoleAccess } from "@/src/hooks/useConsoleAccess.ts";
import { useEngines } from "@/src/hooks/useEngines.ts";
import { useCanManagePermission } from "@/src/hooks/useGatewayConfigurable.ts";
import { useIdentities } from "@/src/hooks/useIdentities.ts";
import { useMcp } from "@/src/hooks/useMcp.ts";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import {
	pluginCompanionPath,
	usePluginContributions,
} from "@/src/hooks/usePluginContributions.ts";
import { useSidebarChatPreview } from "@/src/hooks/useSidebarChatPreview.ts";
import { useSidebarGroupedNav } from "@/src/hooks/useSidebarGroupedNav.ts";
import {
	DEFAULT_SIDEBAR_MODE,
	type SidebarMode,
	useSidebarMode,
} from "@/src/hooks/useSidebarMode.ts";
import { useSidebarModes } from "@/src/hooks/useSidebarModes.ts";
import { useSidebarVariant } from "@/src/hooks/useSidebarVariant.ts";
import { setTabLayout, useTabLayout } from "@/src/hooks/useTabLayout.ts";
import { useTeams } from "@/src/hooks/useTeams.ts";
import { useTimezoneRevision } from "@/src/hooks/useTimezone.ts";
import { useUsageBarPrefs } from "@/src/hooks/useUsageBarPrefs.ts";
import { useVisibilityAdminAccess } from "@/src/hooks/useVisibilityAdminAccess.ts";
import { useVoiceEngines } from "@/src/hooks/useVoiceEngines.ts";
import {
	conversationGroupKey,
	conversationParticipantIds,
	directAgentThreads,
	isForkedConversation,
	isGroupConversation,
} from "@/src/lib/agent-conversation-groups.ts";
import {
	AgentAvatar,
	engineForAgent,
	personaToGlyph,
} from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { BtwEntry } from "@/src/lib/api/btw.ts";
import { CHANNEL_LABELS } from "@/src/lib/api/channels.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { apiUrl, requestHeaders, toTarget } from "@/src/lib/api/client.ts";
import type {
	PluginSidebarButton,
	PluginSidebarSection,
} from "@/src/lib/api/plugins.ts";
import { listSkills } from "@/src/lib/api/skills.ts";
import type { Space, SpaceDocument } from "@/src/lib/api/spaces.ts";
import {
	type BotChatSection,
	type BotChatSectionState,
	conversationsForSection,
	UNORGANIZED_SECTION_ID,
} from "@/src/lib/bot-chat-sections.ts";
import { conversationRunStatusMeta } from "@/src/lib/conversation-run-status.ts";
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
import { dedupeFolders, folderKey } from "@/src/lib/folder-path.ts";
import { useFavorites } from "@/src/lib/library.ts";
import { useNotificationLayout } from "@/src/lib/notification-layout.ts";
import {
	hasPluginChatFeature,
	SIDE_CHAT_FEATURE_KIND,
	SIDE_CHATS_PLUGIN_ID,
} from "@/src/lib/plugin-chat-features.ts";
import { isRyuBot } from "@/src/lib/product.ts";
import { useProductMode } from "@/src/lib/product-mode.ts";
import {
	parseVisibilityDragPayload,
	RESOURCE_VISIBILITY_DND_MIME,
	type ResourceVisibilityGroup,
	resourceVisibilityDndMime,
	resourceVisibilityForGroup,
	resourceVisibilityGroup,
	resourceVisibilityLabel,
	serializeVisibilityDragPayload,
	type VisibilityChangeRequest,
	type VisibilityDragPayload,
	type VisibilityResourceType,
} from "@/src/lib/resource-visibility.ts";
import {
	bucketByDate,
	DATE_BUCKET_LABELS,
	type DateBucket,
	dateBucketKey,
	rowStamp,
	toEpoch,
} from "@/src/lib/sidebar/date-buckets.ts";
import { buildSidebarConversationPreviewStates } from "@/src/lib/sidebar-conversation-preview.ts";
import { compactAge } from "@/src/lib/time.ts";
import { formatDate, formatTime, startOfTodayMs } from "@/src/lib/timezone.ts";
import {
	conversationEntityKey,
	openEntityInNewWindow,
	routeEntityOpen,
} from "@/src/lib/window-routing.ts";
import {
	findWorkspaceProject,
	workspaceProjectName,
} from "@/src/lib/workspace-projects.ts";
import { useChannelSetupDialog } from "@/src/store/useChannelSetupDialog.ts";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import { useCreateAgentDialog } from "@/src/store/useCreateAgentDialog.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	useWorkspaceStore,
	type WorkspaceProject,
} from "@/src/store/useWorkspaceStore.ts";
import type { Conversation } from "@/types/chat.ts";
import { BotConnectionBadge } from "../bot/BotConnectionBadge.tsx";
import { AnnouncementsSection } from "./AnnouncementsSection.tsx";
import { AnimatedTitle } from "./animated-title.tsx";
import {
	ContextMenuSectionHeading,
	SIDEBAR_OVERFLOW_POPOVER_KEY,
	SidebarListAppearanceMenuItems,
	TabLayoutMenuItems,
} from "./appearance-context-menu.tsx";
import { BotChatSectionDialog } from "./BotChatSectionDialog.tsx";
import { CustomizeSidebarDialog } from "./CustomizeSidebarDialog.tsx";
import { NavUser } from "./NavUser.tsx";
import { OverflowTooltip } from "./overflow-tooltip.tsx";
import { PinnedAgentStage } from "./pinned-agent-stage.tsx";
import { type PinnedAppItem, PinnedAppStage } from "./pinned-app-stage.tsx";
import { SidebarBrandBadge } from "./SidebarBrandBadge.tsx";
import { SidebarSectionNav } from "./SidebarSectionNav.tsx";
import { SidebarTodoProgress } from "./SidebarTodoProgress.tsx";
import { SidebarConversationPreview } from "./sidebar-conversation-preview.tsx";
import type { ChatRowHandlers } from "./sidebar-conversation-rows.tsx";
import {
	ChatRow,
	ParticipantOrbitAvatar,
	SidebarSideChats,
} from "./sidebar-conversation-rows.tsx";
import {
	SidebarItemPreview,
	SidebarPreviewMeta,
	SidebarPreviewTitle,
} from "./sidebar-item-preview.tsx";
import {
	orderedSidebarModeSections,
	resolveSidebarMode,
} from "./sidebar-modes.ts";
// The section vocabulary (built-in keys + labels + glyphs) and the order
// persistence/reconciliation that goes with it. Kept in its own module so the
// part that must never lose a user's saved layout is unit-testable without a DOM.
import {
	type BuiltinSectionKey,
	DEFAULT_SECTION_ORDER,
	isDynamicSectionKey,
	isSectionKey,
	loadSectionOrder,
	migrateLegacySectionStorage,
	SECTION_ICONS,
	SECTION_LABELS,
	SECTION_ORDER_KEY,
	type SectionKey,
	SURFACE_PLUGIN_OWNER,
	saveSectionOrder,
} from "./sidebar-sections.ts";
import { TabGlyph, useTabBusy } from "./TitleBar.tsx";
import {
	type EntityRow,
	EntityRowGlyph,
	TabEntityMenuSection,
	useContributedRowsFor,
} from "./tab-entity-menu.tsx";
import { TabRenameInput, useTabRename } from "./tab-rename.tsx";
import { useTabDnd, useTabDragProps } from "./tabDnd.tsx";

// Re-exported so the sidebar stays the single import surface for its own types
// (CustomizeSidebarDialog and friends import them from here, not from the
// vocabulary module).
export type {
	DynamicSectionKey,
	SectionKey,
} from "./sidebar-sections.ts";
export { ChatRow, SidebarSideChats };

// The unread/pinned/archived keys moved to `useConversationFlagsStore` with the
// state they persist — the tab context menus toggle the same flags, and a second
// copy of the keys is the same live desync as a second copy of the state.
// The section order key + its reconciliation live in `sidebar-sections.ts`
// (loadSectionOrder/saveSectionOrder), next to the section vocabulary they
// reconcile against; read/write it through those rather than by key here.
const SECTION_COLLAPSED_KEY = "ryu:sidebar-collapsed-sections";
// The hidden-sections set is owned by `lib/features.ts` (the single source of
// truth shared with onboarding + Settings → Features); read/write it via
// loadHiddenSections/persistHiddenSections rather than the local id-set helpers.
const SECTION_PAGE_SIZE_KEY = "ryu:sidebar-section-page-sizes";
const SECTION_SORT_KEY = "ryu:sidebar-section-sorts";
const CHROME_ORDER_KEY = "ryu:sidebar-chrome-order";

// Sidebar sections whose backing routes are gated by a Core App (`require_app_enabled`
// / the ext-proxy mount, both of which refuse while the owning app is off). When that
// App is disabled or absent the routes fail, so we hide the section rather than leave
// a nav entry that leads to a dead page. Ids mirror
// `apps/core/src/plugins/builtins.rs`.
const SECTION_PLUGIN_OWNER: Partial<Record<SectionKey, string>> = {
	// meetings/canvas/whiteboard are NOT here anymore — each is a fully app-registered
	// `sidebar_sections` contribution (com.ryu.{meetings,canvas,whiteboard}), so its
	// visibility follows the contributions feed (served only when the app is enabled),
	// not a hardcoded owner gate.
	//
	// The ids come from `SURFACE_PLUGIN_OWNER` (sidebar-sections.ts) — the ONE table
	// naming which app owns each compiled-in surface. This map only says which
	// sidebar KEY maps onto which of those surfaces; the Library states the same
	// thing for its own keys against the same table.
	spaces: SURFACE_PLUGIN_OWNER.spaces,
};

// Pin/archive/unread state is local-first: persisted in localStorage rather than
// Core (no schema for it server-side yet). This means it does not sync across
// devices — when cross-device sync is wanted, the home for these flags is Core.
function loadIdSet(key: string): Set<string> {
	try {
		const stored = localStorage.getItem(key);
		return stored ? new Set(JSON.parse(stored)) : new Set();
	} catch {
		return new Set();
	}
}

function saveIdSet(key: string, ids: Set<string>) {
	try {
		localStorage.setItem(key, JSON.stringify([...ids]));
	} catch {
		// best-effort
	}
}

const PATH_SEP_RE = /[\\/]/;
/** Trailing `/` or `\` runs, stripped before taking a path's leaf. */
const TRAILING_SEPARATORS_RE = /[\\/]+$/;

/** Leaf folder name from a workspace path, used as a project's default label.
 *
 *  Trailing separators are dropped first. A path only reaches the sidebar as the
 *  spelling its producer used — the picker, Core, or an imported thread's cwd —
 *  and `"/x/y/".split(sep).pop()` is the empty string, which renders as a project
 *  with no name at all. Comparison is `folderKey`'s job; this is the display half
 *  of the same problem. */
function projectFolderLeaf(path: string): string {
	const trimmed = path.replace(TRAILING_SEPARATORS_RE, "");
	return trimmed.split(PATH_SEP_RE).pop() || trimmed || path;
}

/** Sidebar/picker label: custom display name when set, otherwise the folder leaf. */
function projectName(
	path: string,
	names?: Record<string, string> | null
): string {
	const custom = names?.[path]?.trim();
	if (custom) {
		return custom;
	}
	return projectFolderLeaf(path);
}

/** Adapt a hugeicons glyph into the lucide-shaped IconComponent the TabsSubtle
 *  tab item expects — it renders its icon by calling it with
 *  `size`/`strokeWidth`/`className`, which HugeiconsIcon takes as props. */
function hugeiconTabIcon(icon: IconSvgElement): IconComponent {
	return function TabIcon({
		size,
		strokeWidth,
		className,
	}: {
		size?: number;
		strokeWidth?: number;
		className?: string;
	}) {
		return (
			<HugeiconsIcon
				className={className}
				icon={icon}
				size={size}
				strokeWidth={strokeWidth}
			/>
		);
	};
}

/** The tabbed-mode section glyphs, pre-adapted once so the tab strip never
 *  builds a fresh component per render (which would remount every icon). */
const SECTION_TAB_ICONS: Record<BuiltinSectionKey, IconComponent> =
	Object.fromEntries(
		Object.entries(SECTION_ICONS).map(([key, icon]) => [
			key,
			hugeiconTabIcon(icon),
		])
	) as Record<BuiltinSectionKey, IconComponent>;

// The fixed sidebar "chrome" (header + footer) the user can hide, distinct from
// the reorderable content sections above. These don't reorder; they only hide.
type BuiltinChromeKey =
	| "logo"
	| "node-selector"
	| "home"
	| "new-chat"
	| "search"
	| "library"
	| "memory"
	| "store"
	| "marketplace"
	| "apps"
	| "extensions"
	| "quests"
	| "timeline"
	| "activity"
	| "calendar"
	| "finetune"
	| "inbox"
	| "announcements"
	| "user"
	| "downloads"
	| "settings";

/** A dynamic, app-registered chrome-button key (`plugin:<pluginId>:<buttonId>`),
 *  minted from a `sidebar_buttons` contribution and rendered via DynamicSidebarButton. */
export type DynamicChromeKey = `plugin:${string}`;

export type ChromeKey = BuiltinChromeKey | DynamicChromeKey;

/** First-party Ryu Apps own the app shelf. Their feature navigation belongs inside
 * the app or in contributed sidebar sections, never as a flat host-level button list. */
function isRyuAppId(pluginId: string): boolean {
	return pluginId.startsWith("@ryu/");
}

// Marketplace, Apps, and Extensions folded into the Customize (Store) shell as
// sections — they no longer get their own sidebar buttons. The keys stay in
// ChromeKey/CHROME_LABELS so any persisted user layout referencing them is
// filtered out gracefully rather than crashing. Fleet was retired entirely —
// its cross-node view lives in the node selector and the Store's Installed
// section — so its key is gone and any stale reference falls out via isChromeKey.
//
// Tasks/Timeline/Activity/Calendar left the same way, for a stronger reason: they
// are no longer built-in pages at all. Each is a Ryu App (com.ryu.{quests,timeline,
// activity,calendar}) whose route already mounts `PluginCompanionPage` (see
// `contributions/builtins.ts`), and `AppsSection` lists every ENABLED companion
// straight from `GET /api/plugins/contributions`. A hardcoded button here was a
// second, dumber copy of that list — it rendered whether or not the App was
// installed, so a fresh install (quests/timeline/activity are not pre-installed) showed
// buttons for features the user never had. The App declares itself; the shell does
// not enumerate Apps.
const CHROME_ORDER: ChromeKey[] = [
	"node-selector",
	// "home" is represented by the owning app's Apps-shelf tile.
	"new-chat",
	"search",
	"library",
	// "memory" is represented by the owning app's Apps-shelf tile.
	"store",
	"inbox",
	"announcements",
	"user",
	"downloads",
	"settings",
];

const CHROME_LABELS: Record<BuiltinChromeKey, string> = {
	logo: "Logo",
	"node-selector": "Node selector",
	home: "Home",
	"new-chat": "New chat",
	search: "Search",
	library: "Library",
	memory: "Memory",
	store: "Customize",
	marketplace: "Marketplace",
	apps: "Apps",
	extensions: "Extensions",
	quests: "Tasks",
	timeline: "Timeline",
	activity: "Activity",
	calendar: "Calendar",
	finetune: "Fine-tune",
	inbox: "Inbox",
	announcements: "Announcements",
	user: "Account",
	downloads: "Downloads",
	settings: "Settings",
};

function isChromeKey(value: string): value is ChromeKey {
	return Object.hasOwn(CHROME_LABELS, value);
}
// The chrome that lives in the sidebar footer (NavUser), below the content
// sections. Everything else in CHROME_ORDER is header chrome, above the sections.
// The customize dialog uses this split to list rows top-to-bottom like the sidebar.
const FOOTER_CHROME: ReadonlySet<ChromeKey> = new Set([
	"inbox",
	"announcements",
	"user",
	"downloads",
	"settings",
]);

// The header chrome rendered as a vertical stack of nav buttons, below the
// logo + node-selector row. These reorder *among themselves* (drag, the
// per-button menu, or the customize dialog) — never into the content sections
// below, since they ride a separate drag state. The logo + node-selector row
// stays fixed (it is a horizontal row, not a stacked button).
const HEADER_BUTTON_CHROME: ChromeKey[] = [
	// "home" is represented by the owning app's Apps-shelf tile.
	"new-chat",
	"store",
	"library",
	// "memory" is represented by the owning app's Apps-shelf tile.
];

// Distinct drag-data format for reordering header buttons, so a button drag is
// never confused with the section-reorder drag ("text/plain") or the agent drag.
const CHROME_DND_FORMAT = "application/x-ryu-chrome";

/** A dynamic app-registered chrome-button key (`plugin:<pluginId>:<buttonId>`). */
function isDynamicChromeKey(value: string): value is DynamicChromeKey {
	return value.startsWith("plugin:");
}

function isHeaderButtonChrome(value: string): value is ChromeKey {
	// Accept dynamic `plugin:` keys too, so a persisted order keeps an app's button
	// in place across reloads (it renders nothing when that app is disabled/absent).
	return (
		isDynamicChromeKey(value) ||
		(HEADER_BUTTON_CHROME as string[]).includes(value)
	);
}

// Reconcile a stored header-button order against the code, mirroring
// loadSectionOrder: keep known keys in their stored order, drop unknown ones,
// and splice any never-seen button back beside its default neighbour.
function loadChromeOrder(): ChromeKey[] {
	try {
		const stored = localStorage.getItem(CHROME_ORDER_KEY);
		if (!stored) {
			return [...HEADER_BUTTON_CHROME];
		}
		const parsed = JSON.parse(stored) as string[];
		const order = [...new Set(parsed.filter(isHeaderButtonChrome))];
		const missing = HEADER_BUTTON_CHROME.filter((k) => !order.includes(k));
		for (const key of missing) {
			const defaultIdx = HEADER_BUTTON_CHROME.indexOf(key);
			let insertAt = 0;
			for (let i = defaultIdx - 1; i >= 0; i--) {
				const idx = order.indexOf(HEADER_BUTTON_CHROME[i]);
				if (idx !== -1) {
					insertAt = idx + 1;
					break;
				}
			}
			order.splice(insertAt, 0, key);
		}
		return order;
	} catch {
		return [...HEADER_BUTTON_CHROME];
	}
}

function saveChromeOrder(order: ChromeKey[]) {
	try {
		localStorage.setItem(CHROME_ORDER_KEY, JSON.stringify(order));
	} catch {
		// best-effort
	}
}

// Per-section pagination: a section shows this many items before a "Show more"
// control reveals the next page. 0 means "All" (no cap). Sections default to 10
// items so the sidebar stays compact until the user opts into more (or All).
const PAGE_SIZE_OPTIONS: { label: string; value: number }[] = [
	{ label: "5", value: 5 },
	{ label: "10", value: 10 },
	{ label: "15", value: 15 },
	{ label: "20", value: 20 },
	{ label: "50", value: 50 },
	{ label: "100", value: 100 },
	{ label: "All", value: 0 },
];
const DEFAULT_PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// Scope pickers (the "Projects & Spaces as pickers" model)
// ---------------------------------------------------------------------------
// A section with twenty projects or a dozen spaces spent twenty or a dozen rows
// saying only which containers exist, before showing a single thing inside one. The
// picker inverts that: one row of chrome names the scope, and the whole section body
// is content. The default scope is deliberately "all" rather than the first
// container — the aggregate view is the one that answers "what did I touch
// recently", which is what a sidebar is scanned for.

/** The picker's default option: every container's contents at once. */
const ALL_SELECTION = "all";

const PROJECT_SELECTION_KEY = "ryu:sidebar-project-selection";
const SPACE_VISIBILITY_ORDER_KEY = "ryu:sidebar-space-visibility-order";
const SPACE_VISIBILITY_COLLAPSED_KEY = "ryu:sidebar-collapsed-space-visibility";

/** One picker option. `value` is the container's stable id (a folder path, a space
 *  id); {@link ALL_SELECTION} is reserved for the aggregate. */
interface ScopeOption {
	label: string;
	value: string;
}

/**
 * The picker's current selection, persisted per surface.
 *
 * Falls back to {@link ALL_SELECTION} whenever the stored value names a container
 * that no longer exists — a removed project or a deleted space. Without that the
 * section would render a correctly-empty list for something the user cannot see or
 * change, which reads as the sidebar being broken. The fallback is computed rather
 * than written back, so a container that reappears (a node reconnecting, a slow
 * spaces fetch) restores the user's choice instead of having silently lost it.
 */
function usePickerSelection(
	storageKey: string,
	options: ScopeOption[]
): [string, (value: string) => void] {
	const [stored, setStored] = useState<string>(() => {
		try {
			return localStorage.getItem(storageKey) ?? ALL_SELECTION;
		} catch {
			return ALL_SELECTION;
		}
	});
	const choose = useCallback(
		(value: string) => {
			setStored(value);
			try {
				localStorage.setItem(storageKey, value);
			} catch {
				// best-effort
			}
		},
		[storageKey]
	);
	const known =
		stored === ALL_SELECTION || options.some((o) => o.value === stored);
	return [known ? stored : ALL_SELECTION, choose];
}

/** The picker itself: an "All …" default plus one option per container, sized and
 *  pitched to sit inside a sidebar section body rather than a settings form. */
export function SidebarScopePicker({
	actions,
	allLabel,
	icon,
	onValueChange,
	options,
	value,
}: {
	/**
	 * Verbs for the CURRENT selection, rendered beside the trigger.
	 *
	 * Load-bearing rather than decoration: replacing a row per container with one
	 * picker also removes the row each container's context menu hung off, and some
	 * of those verbs have no other home in the sidebar (activating a project, which
	 * is what the composer's cwd follows; uploading into a space). This slot is
	 * where they land, scoped to whatever the picker currently names.
	 */
	actions?: ReactNode;
	/** Copy for the aggregate option ("All projects" / "All spaces"). */
	allLabel: string;
	/** Usually the owning section's own glyph, so the picker reads as that
	 *  section's control rather than a stray form field. */
	icon?: IconSvgElement;
	onValueChange: (value: string) => void;
	options: ScopeOption[];
	value: string;
}) {
	const items = useMemo(
		() => [{ label: allLabel, value: ALL_SELECTION }, ...options],
		[allLabel, options]
	);
	return (
		<div className="mb-1 flex items-center gap-1 px-2">
			<Select
				items={items}
				// Base UI's change handler can hand back `null` (a cleared select). This
				// picker is never empty — clearing it means the aggregate view.
				onValueChange={(next) => onValueChange(next ?? ALL_SELECTION)}
				value={value}
			>
				<SelectTrigger className="h-7 min-w-0 flex-1 text-xs" variant="ghost">
					<span className="flex min-w-0 items-center gap-2">
						{icon ? (
							<HugeiconsIcon
								className="size-3.5 shrink-0 text-muted-foreground"
								icon={icon}
							/>
						) : null}
						<SelectValue />
					</span>
				</SelectTrigger>
				<SelectContent className="max-h-[50vh]">
					{items.map((item) => (
						<SelectItem key={item.value} value={item.value}>
							{item.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{actions}
		</div>
	);
}

/** The `⋯` beside a scope picker. Mirrors {@link SectionOverflowMenu}'s trigger so
 *  it reads as the same affordance, but always visible rather than hover-revealed:
 *  the verbs behind it are the only path to some of them, so they cannot depend on
 *  the user discovering a hover target on a control they just used. */
function ScopeMenu({
	children,
	label,
}: {
	children: ReactNode;
	label: string;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={label}
				className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[popup-open]:bg-accent"
			>
				<HugeiconsIcon icon={MoreHorizontalIcon} size={14} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-56" sideOffset={6}>
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function loadPageSizes(): Partial<Record<SectionKey, number>> {
	try {
		const stored = localStorage.getItem(SECTION_PAGE_SIZE_KEY);
		if (!stored) {
			return {};
		}
		const parsed = JSON.parse(stored) as Record<string, unknown>;
		const out: Partial<Record<SectionKey, number>> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (isSectionKey(key) && typeof value === "number") {
				out[key] = value;
			}
		}
		return out;
	} catch {
		return {};
	}
}

function savePageSizes(sizes: Partial<Record<SectionKey, number>>) {
	try {
		localStorage.setItem(SECTION_PAGE_SIZE_KEY, JSON.stringify(sizes));
	} catch {
		// best-effort
	}
}

// Per-section sort: how a section orders its items before pagination. "default"
// keeps the source order (already newest-first for chats), the rest re-sort by a
// shared accessor so the same option works for chats, agents, teams, spaces, and
// workflows alike (every item type exposes a name/title + created/updated stamp).
type SortKey = "default" | "updated" | "created" | "name-asc" | "name-desc";

const SORT_OPTIONS: { label: string; value: SortKey }[] = [
	{ label: "Default", value: "default" },
	{ label: "Last updated", value: "updated" },
	{ label: "Recently created", value: "created" },
	{ label: "Name (A-Z)", value: "name-asc" },
	{ label: "Name (Z-A)", value: "name-desc" },
];
const DEFAULT_SORT: SortKey = "default";
const SORT_KEYS: ReadonlySet<string> = new Set(
	SORT_OPTIONS.map((o) => o.value)
);

function isSortKey(value: string): value is SortKey {
	return SORT_KEYS.has(value);
}

/** Accessors so one sorter serves every item type, whatever its field names. */
interface SortAccessors<T> {
	created: (item: T) => number | string | null | undefined;
	name: (item: T) => string;
	updated: (item: T) => number | string | null | undefined;
}

/** Return a sorted copy for the chosen option (same array ref for "default"). */
function sortItems<T>(
	items: T[],
	sort: SortKey,
	accessors: SortAccessors<T>
): T[] {
	if (sort === "default") {
		return items;
	}
	const copy = [...items];
	switch (sort) {
		case "updated":
			copy.sort(
				(a, b) => toEpoch(accessors.updated(b)) - toEpoch(accessors.updated(a))
			);
			break;
		case "created":
			copy.sort(
				(a, b) => toEpoch(accessors.created(b)) - toEpoch(accessors.created(a))
			);
			break;
		case "name-asc":
			copy.sort((a, b) => accessors.name(a).localeCompare(accessors.name(b)));
			break;
		case "name-desc":
			copy.sort((a, b) => accessors.name(b).localeCompare(accessors.name(a)));
			break;
		default:
			break;
	}
	return copy;
}

// Two stable accessor sets cover every section: conversations key off `title`,
// while agents/teams/spaces/workflows all share `name` + created/updated stamps.
const CONV_SORT_ACCESSORS: SortAccessors<Conversation> = {
	created: (c) => c.createdAt,
	name: (c) => c.title,
	updated: (c) => c.updatedAt,
};

// Date-grouping accessors, at module scope so {@link DateGroupedRows} memoizes on a
// stable identity instead of re-bucketing on every parent render.

/** A chat is dated by last activity — the same stamp its rows already show. */
const conversationStamp = (c: Conversation) => c.updatedAt;

/** A Space page is dated by its latest edit, falling back to creation for legacy
 *  rows. For the Uploads Space, creation still equals the upload date until a file
 *  is edited, which is the useful age to show while scanning its contents. */
const spaceDocumentStamp = (d: SpaceDocument) => d.updatedAt || d.createdAt;

/** Sort Space documents by title / their latest edit. */
const SPACE_DOC_SORT_ACCESSORS: SortAccessors<SpaceDocument> = {
	created: (d) => d.createdAt,
	name: (d) => d.title,
	updated: (d) => d.updatedAt || d.createdAt,
};

const NAMED_SORT_ACCESSORS: SortAccessors<{
	createdAt?: number | string | null;
	name: string;
	updatedAt?: number | string | null;
}> = {
	created: (item) => item.createdAt,
	name: (item) => item.name,
	updated: (item) => item.updatedAt,
};

function loadSorts(): Partial<Record<SectionKey, SortKey>> {
	try {
		const stored = localStorage.getItem(SECTION_SORT_KEY);
		if (!stored) {
			return {};
		}
		const parsed = JSON.parse(stored) as Record<string, unknown>;
		const out: Partial<Record<SectionKey, SortKey>> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (isSectionKey(key) && typeof value === "string" && isSortKey(value)) {
				out[key] = value;
			}
		}
		return out;
	} catch {
		return {};
	}
}

function saveSorts(sorts: Partial<Record<SectionKey, SortKey>>) {
	try {
		localStorage.setItem(SECTION_SORT_KEY, JSON.stringify(sorts));
	} catch {
		// best-effort
	}
}

/** Limit a list to `pageSize` items (0 = all) with an incremental reveal. */
function usePaged<T>(items: T[], pageSize: number) {
	const [pages, setPages] = useState(1);
	const [prevPageSize, setPrevPageSize] = useState(pageSize);
	// Reset to the first page when the chosen page size changes, using React's
	// "adjust state during render" pattern so it happens before paint, no effect.
	if (prevPageSize !== pageSize) {
		setPrevPageSize(pageSize);
		setPages(1);
	}
	const limit = pageSize > 0 ? pageSize * pages : items.length;
	const remaining = Math.max(0, items.length - limit);
	const lessCount =
		pageSize > 0 ? Math.min(pageSize, Math.max(0, limit - pageSize)) : 0;
	return {
		// The full (sorted) source list, so the popover-overflow mode can offer a
		// searchable view over every item — not just the page-1 slice shown inline.
		items,
		visible: items.slice(0, limit),
		hasMore: pageSize > 0 && remaining > 0,
		canShowLess: pageSize > 0 && pages > 1,
		remaining,
		lessCount,
		showMore: () => setPages((prev) => prev + 1),
		showLess: () => setPages((prev) => Math.max(1, prev - 1)),
	};
}

// How many rows the overflow popover reveals per infinite-scroll step.
const OVERFLOW_WINDOW_STEP = 30;

/** Describes a section's full list so the overflow popover can render + search
 *  it with the section's own rows (preserving context menus, side-chats, etc.). */
interface SectionOverflow<T> {
	/** Text a row is matched against when filtering. */
	getSearchText: (item: T) => string;
	/** Full sorted list (usually `paged.items`). */
	items: T[];
	/** Human label for the search placeholder, e.g. "agents". */
	label: string;
	/** Renders the given slice using the section's real rows. */
	renderList: (items: T[]) => ReactNode;
}

/** The "Show N more" trigger that opens a searchable, infinite-scrolled popover
 *  of the section's full list to the right of the sidebar. Exported so the e2e
 *  harness can mount it in isolation. */
export function SectionOverflowPopover<T>({
	remaining,
	overflow,
}: {
	remaining: number;
	overflow: SectionOverflow<T>;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [windowCount, setWindowCount] = useState(OVERFLOW_WINDOW_STEP);
	const sentinelRef = useRef<HTMLDivElement | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) {
			return overflow.items;
		}
		return overflow.items.filter((item) =>
			overflow.getSearchText(item).toLowerCase().includes(q)
		);
	}, [overflow, query]);

	const windowed = filtered.slice(0, windowCount);
	const hasMore = filtered.length > windowCount;

	// Grow the window as the sentinel scrolls into view (in-memory windowing —
	// the data is already client-side, so no fetch paging is needed).
	useEffect(() => {
		if (!(open && hasMore)) {
			return;
		}
		const sentinel = sentinelRef.current;
		const root = scrollRef.current;
		if (!sentinel) {
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					setWindowCount((c) => c + OVERFLOW_WINDOW_STEP);
				}
			},
			{ root, rootMargin: "120px" }
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [open, hasMore]);

	const onOpenChange = (next: boolean) => {
		setOpen(next);
		if (next) {
			// Fresh view each open: clear the filter and collapse the window.
			setQuery("");
			setWindowCount(OVERFLOW_WINDOW_STEP);
		}
	};

	return (
		<Popover onOpenChange={onOpenChange} open={open}>
			<div className="mt-0.5 flex items-center gap-1 pl-6">
				<PopoverTrigger className="rounded px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground">
					Show {remaining} more
				</PopoverTrigger>
			</div>
			<PopoverContent
				align="start"
				className="flex w-64 flex-col gap-2 rounded-2xl p-2"
				side="right"
				sideOffset={8}
			>
				<div className="flex items-center gap-2 rounded-md border border-border/50 bg-background/50 px-2">
					<HugeiconsIcon
						className="shrink-0 text-muted-foreground"
						icon={Search01Icon}
						size={14}
					/>
					{/* biome-ignore lint/a11y/noAutofocus: search field is the popover's primary action */}
					<input
						autoFocus
						className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
						onChange={(e) => {
							setQuery(e.target.value);
							setWindowCount(OVERFLOW_WINDOW_STEP);
						}}
						placeholder={`Search ${overflow.label}`}
						type="text"
						value={query}
					/>
				</div>
				{/* Content dissolves under the search field above rather than
				    meeting it at a hard line. Top-only: the list ends on the
				    popover edge, so a bottom fade would just dim the last row. */}
				<div
					className="ryu-scroll-edge-top max-h-80 overflow-y-auto overscroll-contain"
					ref={scrollRef}
				>
					{windowed.length === 0 ? (
						<p className="px-2 py-2 text-muted-foreground text-xs">
							No matches
						</p>
					) : (
						<>
							{overflow.renderList(windowed)}
							{hasMore ? <div aria-hidden="true" ref={sentinelRef} /> : null}
						</>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}

function SectionPagingControls<T>({
	paged,
	overflow,
}: {
	paged: {
		canShowLess: boolean;
		hasMore: boolean;
		lessCount: number;
		remaining: number;
		showLess: () => void;
		showMore: () => void;
	};
	/** When provided and the popover overflow mode is on, "Show N more" opens a
	 *  searchable popover instead of revealing the next page inline. */
	overflow?: SectionOverflow<T>;
}) {
	const [popoverMode] = usePersistedToggle(SIDEBAR_OVERFLOW_POPOVER_KEY, false);
	if (!(paged.hasMore || paged.canShowLess)) {
		return null;
	}
	if (popoverMode && overflow && paged.hasMore) {
		return (
			<SectionOverflowPopover overflow={overflow} remaining={paged.remaining} />
		);
	}
	return (
		<div className="mt-0.5 flex items-center gap-1 pl-6">
			{paged.hasMore ? (
				<ShowMoreButton onClick={paged.showMore} remaining={paged.remaining} />
			) : null}
			{paged.canShowLess ? (
				<ShowLessButton count={paged.lessCount} onClick={paged.showLess} />
			) : null}
		</div>
	);
}

/** A row that reveals the next page of items in a paginated section. */
function ShowMoreButton({
	onClick,
	remaining,
}: {
	onClick: () => void;
	remaining: number;
}) {
	return (
		<button
			className="rounded px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
			onClick={onClick}
			type="button"
		>
			Show {remaining} more
		</button>
	);
}

/** A row that hides the last revealed page in a paginated section. */
function ShowLessButton({
	count,
	onClick,
}: {
	count: number;
	onClick: () => void;
}) {
	return (
		<button
			className="rounded px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
			onClick={onClick}
			type="button"
		>
			Show {count} less
		</button>
	);
}

/** Shared callbacks/state threaded into every chat row, regardless of group. */

interface ConversationListEntry {
	conversation?: Conversation;
	groupKey?: string;
	threads?: Conversation[];
}

/** Collapse all conversations with the same participant set into one group
 *  header while preserving the original activity order. */
function groupConversationEntries(
	conversations: Conversation[]
): ConversationListEntry[] {
	const entries: ConversationListEntry[] = [];
	const groups = new Map<string, ConversationListEntry>();
	for (const conversation of conversations) {
		const groupKey = conversationGroupKey(conversation);
		if (!groupKey) {
			entries.push({ conversation });
			continue;
		}
		const existing = groups.get(groupKey);
		if (existing) {
			existing.threads?.push(conversation);
			continue;
		}
		const entry: ConversationListEntry = {
			groupKey,
			threads: [conversation],
		};
		groups.set(groupKey, entry);
		entries.push(entry);
	}
	return entries;
}

function groupParticipantLabel(
	conversation: Conversation,
	agents: AgentSummary[]
): string {
	const names = conversationParticipantIds(conversation).map(
		(id) => agents.find((agent) => agent.id === id)?.name ?? id
	);
	if (names.length === 0) {
		return "Multiple participants";
	}
	if (names.length <= 3) {
		return names.join(" · ");
	}
	return `${names.slice(0, 2).join(" · ")} +${names.length - 2}`;
}

/** One group-chat header with the same paginated child rows used by the rest of
 *  the sidebar. The child rows remain real ChatRows, so rename/archive/open and
 *  the existing Messages/Side chats accordions keep their behavior. */
function GroupChatRow({
	handlers,
	pageSize,
	threads,
}: {
	handlers: ChatRowHandlers;
	pageSize: number;
	threads: Conversation[];
}) {
	const [expanded, setExpanded] = useState(false);
	const paged = usePaged(threads, pageSize);
	const latest = threads[0];
	if (!latest) {
		return null;
	}
	const participants = conversationParticipantIds(latest);
	const participantLabel = groupParticipantLabel(latest, handlers.agents);
	const preview = latest.lastMessage?.trim();
	const openLatest = () => handlers.onSelectConversation(latest.id);
	return (
		<SidebarMenuItem>
			{/* biome-ignore lint/a11y/useSemanticElements: group header owns a disclosure button and a row-level open action */}
			<div
				className="group/group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted"
				onClick={openLatest}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						openLatest();
					}
				}}
				role="button"
				tabIndex={0}
			>
				<button
					aria-expanded={expanded}
					aria-label={`${expanded ? "Collapse" : "Expand"} group chat threads`}
					className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
					onClick={(event) => {
						event.stopPropagation();
						setExpanded((value) => !value);
					}}
					type="button"
				>
					<HugeiconsIcon
						className={`size-3 transition-transform ${expanded ? "" : "-rotate-90"}`}
						icon={ArrowDown01Icon}
					/>
				</button>
				<ParticipantOrbitAvatar
					agents={handlers.agents}
					participants={participants}
					size="md"
				/>
				<span className="min-w-0 flex-1">
					<span className="flex min-w-0 items-center gap-2">
						<span className="truncate font-medium text-sm">Group chat</span>
						<span className="shrink-0 text-[10px] text-muted-foreground/70 tabular-nums">
							{compactAge(latest.updatedAt)}
						</span>
					</span>
					<span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
						<span className="min-w-0 flex-1 truncate">{participantLabel}</span>
						{preview ? (
							<span className="max-w-[45%] truncate text-muted-foreground/70">
								{preview}
							</span>
						) : null}
					</span>
				</span>
				<span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
					{formatCount(threads.length) ?? "—"}
				</span>
			</div>
			{expanded ? (
				<div className="relative ml-7 border-sidebar-border/70 border-l pl-2">
					<SidebarMenu className="gap-0.5">
						{paged.visible.map((conversation) => (
							<ChatRow
								conv={conversation}
								handlers={handlers}
								key={conversation.id}
							/>
						))}
					</SidebarMenu>
					<SectionPagingControls
						overflow={{
							getSearchText: (conversation) => conversation.title,
							items: paged.items,
							label: "group threads",
							renderList: (list) => (
								<SidebarMenu className="gap-0.5">
									{list.map((conversation) => (
										<ChatRow
											conv={conversation}
											handlers={handlers}
											key={conversation.id}
										/>
									))}
								</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</div>
			) : null}
		</SidebarMenuItem>
	);
}

/** Renders chat rows, converging multi-participant conversations into group
 *  chats with expandable/paginated child threads. */
function ChatRowList({
	className,
	conversations,
	handlers,
	groupMultiParticipant = true,
	pageSize = DEFAULT_PAGE_SIZE,
}: {
	className?: string;
	conversations: Conversation[];
	groupMultiParticipant?: boolean;
	handlers: ChatRowHandlers;
	pageSize?: number;
}) {
	const entries: ConversationListEntry[] = groupMultiParticipant
		? groupConversationEntries(conversations)
		: conversations.map((conversation) => ({ conversation }));
	return (
		<SidebarMenu className={className ?? "gap-0.5"}>
			{entries.map((entry) =>
				entry.threads ? (
					<GroupChatRow
						handlers={handlers}
						key={entry.groupKey}
						pageSize={pageSize}
						threads={entry.threads}
					/>
				) : entry.conversation ? (
					<ChatRow
						conv={entry.conversation}
						handlers={handlers}
						key={entry.conversation.id}
					/>
				) : null
			)}
		</SidebarMenu>
	);
}

/** The production conversation-list seam, exported for browser stories that
 *  need to exercise grouping without mounting the whole desktop shell. */
export function SidebarConversationList({
	conversations,
	groupMultiParticipant = true,
	handlers,
	pageSize = DEFAULT_PAGE_SIZE,
}: {
	conversations: Conversation[];
	groupMultiParticipant?: boolean;
	handlers: ChatRowHandlers;
	pageSize?: number;
}) {
	return (
		<ChatRowList
			conversations={conversations}
			groupMultiParticipant={groupMultiParticipant}
			handlers={handlers}
			pageSize={pageSize}
		/>
	);
}

interface ProjectBucket {
	conversations: Conversation[];
	name: string;
	path: string;
	sourceFolders: string[];
}

/** Group conversations by their workspace folder (Codex-style projects). */
function groupByProject(
	convs: Conversation[],
	workspaceProjects: readonly WorkspaceProject[] = []
): {
	projects: ProjectBucket[];
	loose: Conversation[];
} {
	// Keyed by `folderKey`, not the raw string: an imported thread's cwd and a
	// native run's folder are produced by different writers and differ by
	// punctuation often enough that raw equality split one project in two.
	const projects = new Map<string, ProjectBucket>();
	const projectByFolder = new Map<string, WorkspaceProject>();
	for (const project of workspaceProjects) {
		for (const folder of project.folders) {
			projectByFolder.set(folderKey(folder), project);
		}
	}
	const loose: Conversation[] = [];
	for (const conv of convs) {
		if (!conv.folderPath) {
			loose.push(conv);
			continue;
		}
		const workspaceProject = projectByFolder.get(folderKey(conv.folderPath));
		const projectPath = workspaceProject?.folders[0] ?? conv.folderPath;
		const existing = projects.get(folderKey(projectPath));
		if (existing) {
			existing.conversations.push(conv);
		} else {
			projects.set(folderKey(projectPath), {
				name: workspaceProject
					? workspaceProjectName(workspaceProject)
					: projectFolderLeaf(projectPath),
				path: projectPath,
				sourceFolders: workspaceProject?.folders ?? [conv.folderPath],
				conversations: [conv],
			});
		}
	}
	return { projects: [...projects.values()], loose };
}

/** Drag-and-drop wiring threaded into every reorderable section header. */
interface SectionDnd {
	draggingKey: SectionKey | null;
	dragOverKey: SectionKey | null;
	onDragEnd: () => void;
	onDragOver: (key: SectionKey) => void;
	onDragStart: (key: SectionKey) => void;
	onDrop: (key: SectionKey) => void;
	/** Current section order, so a target can tell which side to draw the drop line. */
	order: SectionKey[];
}

/** The per-section overflow menu: move, hide, page size, sort, and customize. */
interface SectionMenu {
	canMove: (key: SectionKey, dir: "up" | "down") => boolean;
	onHide: (key: SectionKey) => void;
	onMove: (key: SectionKey, dir: "up" | "down") => void;
	onOpenCustomize: () => void;
	onSetPageSize: (key: SectionKey, size: number) => void;
	onSetSort: (key: SectionKey, sort: SortKey) => void;
}

interface SectionProps {
	collapsed: boolean;
	dnd: SectionDnd;
	/** Shared section glyph used by both the stacked header and tabbed selector. */
	icon?: IconSvgElement;
	menu: SectionMenu;
	onToggleCollapsed: (key: SectionKey) => void;
	/** Items to show before a "Show more" control (0 means show all). */
	pageSize: number;
	/** How this section orders its items before pagination. */
	sort: SortKey;
}

/** A small "+" affordance in a section header, revealed on section hover. */
function SectionActionButton({
	icon,
	onClick,
	title,
}: {
	icon: IconSvgElement;
	onClick: () => void;
	title: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						aria-label={title}
						className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/section:opacity-100"
						onClick={(e) => {
							e.stopPropagation();
							onClick();
						}}
						type="button"
					>
						<HugeiconsIcon icon={icon} size={14} />
					</button>
				}
			/>
			<TooltipContent>{title}</TooltipContent>
		</Tooltip>
	);
}

function SectionAddButton({
	onClick,
	title,
}: {
	onClick: () => void;
	title: string;
}) {
	return (
		<span className="mr-1">
			<SectionActionButton icon={Add01Icon} onClick={onClick} title={title} />
		</span>
	);
}

/** Hover-reveal action for a nested sub-section header (project folder / date
 *  bucket). Same affordance as {@link SectionActionButton} but keyed to the
 *  sub-section's own `group/subsection` hover so it shows only for the folder
 *  the pointer is over, not the whole section. */
function SubSectionActionButton({
	icon,
	onClick,
	title,
}: {
	icon: IconSvgElement;
	onClick: () => void;
	title: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						aria-label={title}
						className="flex size-5 shrink-0 items-center justify-center rounded bg-transparent text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/subsection:opacity-100"
						onClick={(e) => {
							e.stopPropagation();
							onClick();
						}}
						type="button"
					>
						<HugeiconsIcon icon={icon} size={14} />
					</button>
				}
			/>
			<TooltipContent>{title}</TooltipContent>
		</Tooltip>
	);
}

/** The "…" overflow menu shown in every section header: move the section up or
 *  down (relative to its visible neighbours), hide it, choose how many items to
 *  show before paginating, or open the customize dialog. */
function SectionOverflowMenu({
	label,
	menu,
	pageSize,
	sectionKey,
	sort,
}: {
	label: string;
	menu: SectionMenu;
	pageSize: number;
	sectionKey: SectionKey;
	sort: SortKey;
}) {
	return (
		<DropdownMenu>
			{/* data-[popup-open] keeps the trigger visible while the menu is open, so
			    it neither fades out under the cursor nor loses its anchor. Base UI sets
			    data-popup-open, not data-state, on the trigger. */}
			<DropdownMenuTrigger
				aria-label={`${label} options`}
				className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/section:opacity-100 data-[popup-open]:opacity-100"
				onClick={(e) => e.stopPropagation()}
			>
				<HugeiconsIcon icon={MoreHorizontalIcon} size={14} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem
					disabled={!menu.canMove(sectionKey, "up")}
					onClick={() => menu.onMove(sectionKey, "up")}
				>
					<HugeiconsIcon className="mr-2" icon={ArrowUp01Icon} size={14} />
					Move up
				</DropdownMenuItem>
				<DropdownMenuItem
					disabled={!menu.canMove(sectionKey, "down")}
					onClick={() => menu.onMove(sectionKey, "down")}
				>
					<HugeiconsIcon className="mr-2" icon={ArrowDown01Icon} size={14} />
					Move down
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => menu.onHide(sectionKey)}>
					<HugeiconsIcon className="mr-2" icon={ViewOffSlashIcon} size={14} />
					Hide section
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>Sort by</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						<DropdownMenuRadioGroup
							onValueChange={(value: string) => {
								if (isSortKey(value)) {
									menu.onSetSort(sectionKey, value);
								}
							}}
							value={sort}
						>
							{SORT_OPTIONS.map((opt) => (
								<DropdownMenuRadioItem key={opt.value} value={opt.value}>
									{opt.label}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>Show items</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						<DropdownMenuRadioGroup
							onValueChange={(value: string) =>
								menu.onSetPageSize(sectionKey, Number(value))
							}
							value={String(pageSize)}
						>
							{PAGE_SIZE_OPTIONS.map((opt) => (
								<DropdownMenuRadioItem
									key={opt.value}
									value={String(opt.value)}
								>
									{opt.label}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={menu.onOpenCustomize}>
					<HugeiconsIcon
						className="mr-2"
						icon={SlidersHorizontalIcon}
						size={14}
					/>
					Customize sidebar
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Top-level collapsible + draggable section shell. The header doubles as the
 *  collapse toggle (click) and the drag handle (drag); the browser suppresses
 *  the click that follows a drag, so the two gestures don't collide. */
function SidebarSection({
	action,
	children,
	collapsed,
	dnd,
	icon,
	iconNode,
	label,
	menu,
	onToggleCollapsed,
	pageSize,
	sectionKey,
	sort,
	title,
	wrapHeader,
}: SectionProps & {
	action?: ReactNode;
	children: ReactNode;
	icon?: IconSvgElement;
	iconNode?: ReactNode;
	label: string;
	sectionKey: SectionKey;
	title?: string;
	/** Optional wrapper for the header row — e.g. a right-click "Delete all
	 *  chats" context menu. Defaults to identity (no wrapper). */
	wrapHeader?: (header: ReactNode) => ReactNode;
}) {
	const isDragOver =
		dnd.dragOverKey === sectionKey &&
		dnd.draggingKey !== null &&
		dnd.draggingKey !== sectionKey;
	const isDragging = dnd.draggingKey === sectionKey;
	// The drop inserts after the target when dragging downward, before it when
	// dragging upward — so draw the indicator line on the matching edge.
	const dropBelow =
		isDragOver &&
		dnd.draggingKey !== null &&
		dnd.order.indexOf(dnd.draggingKey) < dnd.order.indexOf(sectionKey);
	const headerButton = (
		<button
			className="group/hdr flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground text-xs transition-colors active:cursor-grabbing"
			draggable
			onClick={() => onToggleCollapsed(sectionKey)}
			onDragEnd={() => dnd.onDragEnd()}
			onDragStart={(e) => {
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", sectionKey);
				dnd.onDragStart(sectionKey);
			}}
			type="button"
		>
			{iconNode ??
				(icon && <HugeiconsIcon className="size-3.5 shrink-0" icon={icon} />)}
			<span className="min-w-0 truncate">{label}</span>
			<HugeiconsIcon
				className={`-ml-1 size-3 shrink-0 opacity-0 transition group-hover/hdr:opacity-100 ${collapsed ? "-rotate-90" : ""}`}
				icon={ArrowDown01Icon}
			/>
		</button>
	);
	return (
		<SidebarGroup
			className={`group/section scroll-mt-2 py-1 ${isDragging ? "opacity-50" : ""}`}
			id={`sidebar-sec-${sectionKey}`}
			onDragOver={(e) => {
				if (dnd.draggingKey) {
					e.preventDefault();
					e.dataTransfer.dropEffect = "move";
					dnd.onDragOver(sectionKey);
				}
			}}
			onDrop={(e) => {
				e.preventDefault();
				dnd.onDrop(sectionKey);
			}}
		>
			{isDragOver && (
				<div
					className={`reorder-drop-indicator pointer-events-none absolute inset-x-2 z-10 h-0.5 bg-primary ${dropBelow ? "bottom-0" : "top-0"}`}
				/>
			)}
			{(() => {
				const headerRow = (
					<div className="relative flex items-center">
						{title ? (
							<Tooltip>
								<TooltipTrigger render={headerButton} />
								<TooltipContent align="start">{title}</TooltipContent>
							</Tooltip>
						) : (
							headerButton
						)}
						<div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center">
							{action}
							<SectionOverflowMenu
								label={label}
								menu={menu}
								pageSize={pageSize}
								sectionKey={sectionKey}
								sort={sort}
							/>
						</div>
					</div>
				);
				return wrapHeader ? wrapHeader(headerRow) : headerRow;
			})()}
			{!collapsed && <SidebarGroupContent>{children}</SidebarGroupContent>}
		</SidebarGroup>
	);
}

/** A single open tab rendered as a vertical sidebar row (Zen-style vertical
    tabs). Mirrors the title-bar chip: click to activate, middle-click or the
    hover × to close, right-click for pin/split/duplicate/close. Split members
    get a left accent so a contiguous split reads as one block in the list. */
function VerticalTabRow({ tab, isActive }: { tab: Tab; isActive: boolean }) {
	const {
		tabs,
		splits,
		activeTabId,
		activateTab,
		closeTab,
		openTab,
		togglePin,
		unloadTab,
		splitTabs,
		unsplit,
	} = useTabsContext();
	const inSplit = !!tab.splitId;
	const tabLayout = useTabLayout();
	const activeSplit = findSplit(tabs, splits, activeTabId);
	const inActiveSplit = inSplit && tab.splitId === activeSplit?.id;
	const { isDragging, showBefore, showAfter, dragHandlers } = useTabDragProps(
		tab.id,
		"y"
	);
	const busy = useTabBusy(tab);
	const openTabInNewWindow = () => {
		const overrideName = useNodeStore.getState().tabOverrides[tab.id];
		void openEntityInNewWindow({
			conversationId: tab.conversationId,
			node: overrideName,
			path: tab.path,
			title: tab.title,
		});
	};
	const rowState = isActive ? "bg-muted" : "hover:bg-muted/60";
	const textState = isActive ? "text-foreground" : "text-muted-foreground";
	const {
		isEditing,
		canRename,
		startEditing,
		commitEditing,
		cancelEditing,
		draft,
		setDraft,
	} = useTabRename(tab);

	return (
		<SidebarMenuItem>
			<ContextMenu>
				<ContextMenuTrigger>
					{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
					<div
						className={`group/row relative flex h-8 cursor-pointer items-center gap-2 rounded-md pr-2 pl-2 transition-colors ${rowState} ${tab.unloaded ? "opacity-60" : ""} ${isDragging ? "opacity-40" : ""}`}
						onClick={() => activateTab(tab.id)}
						onDoubleClick={canRename ? startEditing : undefined}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								activateTab(tab.id);
							}
						}}
						onMouseDown={(e) => {
							if (e.button === 1) {
								e.preventDefault();
								closeTab(tab.id);
							}
						}}
						role="button"
						tabIndex={0}
						{...dragHandlers}
					>
						{showBefore && (
							<span
								aria-hidden
								className="reorder-drop-indicator pointer-events-none absolute inset-x-1 -top-0.5 z-20 h-0.5 bg-primary"
							/>
						)}
						{showAfter && (
							<span
								aria-hidden
								className="reorder-drop-indicator pointer-events-none absolute inset-x-1 -bottom-0.5 z-20 h-0.5 bg-primary"
							/>
						)}
						{inSplit && (
							<span
								aria-hidden
								className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary/60"
							/>
						)}
						{/* Icon zone — page icon morphs to close X on row hover */}
						<button
							aria-label={`Close ${tab.title}`}
							className={`relative flex size-4 shrink-0 items-center justify-center rounded-full ${textState}`}
							onClick={(e) => {
								e.stopPropagation();
								closeTab(tab.id);
							}}
							type="button"
						>
							<TabGlyph
								busy={busy}
								busySpeed={tab.busySpeed}
								className="absolute size-4 transition-all duration-150 group-hover/row:scale-50 group-hover/row:opacity-0"
								icon={tab.icon}
								logoSize="16px"
								path={tab.path}
								unloaded={tab.unloaded}
							/>
							<HugeiconsIcon
								className="absolute size-3.5 scale-50 opacity-0 transition-all duration-150 group-hover/row:scale-100 group-hover/row:opacity-100"
								icon={Cancel01Icon}
							/>
						</button>
						{/* Busy and resting share one label: the shimmer rides the same
						    faded clip line, so a streaming title never falls back to an
						    ellipsis and the row cannot jump as a run starts or ends.
						    A double-click on the row starts an inline rename for a
						    renamable tab, replacing the label with the input below. */}
						{isEditing ? (
							<TabRenameInput
								className="text-sm"
								onCancel={cancelEditing}
								onChange={setDraft}
								onCommit={commitEditing}
								value={draft}
							/>
						) : (
							<OverflowTooltip
								className={`min-w-0 flex-1 overflow-hidden whitespace-nowrap text-sm ${textState} ${tab.unloaded ? "italic" : ""}`}
								fade
								shimmer={busy && !tab.unloaded}
								text={tab.title}
							/>
						)}
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem onClick={() => togglePin(tab.id)}>
						<HugeiconsIcon
							className="mr-2 size-4"
							icon={tab.pinned ? PinOffIcon : PinIcon}
						/>
						{tab.pinned ? "Unpin tab" : "Pin tab"}
					</ContextMenuItem>
					<ContextMenuItem
						disabled={isActive || tab.unloaded || inActiveSplit}
						onClick={() => unloadTab(tab.id)}
					>
						Unload tab
					</ContextMenuItem>
					{inSplit ? (
						<ContextMenuItem onClick={() => unsplit(tab.id)}>
							<HugeiconsIcon className="mr-2 size-4" icon={GridIcon} />
							Unsplit
						</ContextMenuItem>
					) : (
						<ContextMenuItem
							onClick={() => {
								const id = openTab("/chat", { forceNew: true });
								splitTabs([tab.id, id]);
							}}
						>
							<HugeiconsIcon className="mr-2 size-4" icon={GridIcon} />
							Split with new chat
						</ContextMenuItem>
					)}
					{/* Verbs for the thing the tab is SHOWING — the same section the
					    horizontal strip's pills get, so a vertical tab is not a
					    second-class surface. Renders nothing for a tab with no entity. */}
					<TabEntityMenuSection tab={tab} />
					<ContextMenuSeparator />
					<ContextMenuItem
						onClick={() =>
							openTab(tab.path, {
								conversationId: tab.conversationId,
								forceNew: true,
								title: tab.title,
								icon: tab.icon,
							})
						}
					>
						<HugeiconsIcon className="mr-2 size-4" icon={ArrowUpRight01Icon} />
						Duplicate tab
					</ContextMenuItem>
					<OpenInNewWindowContextMenuItem onClick={openTabInNewWindow} />
					<TabLayoutMenuItems onChange={setTabLayout} value={tabLayout} />
					<ContextMenuSeparator />
					<ContextMenuItem onClick={() => closeTab(tab.id)}>
						<HugeiconsIcon className="mr-2 size-4" icon={Cancel01Icon} />
						Close tab
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
		</SidebarMenuItem>
	);
}

/** A contiguous split's members in the vertical list, bracketed as one block
    (the vertical answer to the strip's split bracket): a header row names the
    split's arrangement and takes drops to add panes; member rows render in
    PANE order so the list mirrors the on-screen tiling. */
function VerticalSplitBlock({
	split,
	members,
	activeTabId,
}: {
	activeTabId: string;
	members: Tab[];
	split: Split;
}) {
	const { tabs, addTabToSplit, setSplitOrientation, unsplit } =
		useTabsContext();
	const dnd = useTabDnd();
	const [joinHover, setJoinHover] = useState(false);
	const canJoin =
		!!dnd.draggingId &&
		tabs.find((t) => t.id === dnd.draggingId)?.splitId !== split.id;
	// Show rows in pane order (the tree's leaf order), not strip order, so the
	// list reads top-to-bottom the way the panes tile.
	const ordered = splitPaneTabs(tabs, split).filter((t) =>
		members.some((m) => m.id === t.id)
	);
	const label =
		split.root.orientation === "columns" ? "Side by side" : "Stacked";
	return (
		<div className="rounded-lg bg-primary/5 p-0.5 ring-1 ring-primary/25">
			{/* The header row carries the split's own verbs, mirroring the strip's
			    split bracket — orientation, layout presets, equalize, unsplit —
			    so the vertical layout is not a second-class surface. */}
			<ContextMenu>
				<ContextMenuTrigger>
					{/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop join target; the same action exists in the tab context menus */}
					<div
						className={`flex h-6 items-center gap-1.5 rounded-md px-2 text-primary/70 ${joinHover ? "bg-primary/20 text-primary" : ""}`}
						onDragLeave={() => setJoinHover(false)}
						onDragOver={(e: ReactDragEvent) => {
							if (!canJoin) {
								return;
							}
							e.preventDefault();
							e.stopPropagation();
							e.dataTransfer.dropEffect = "move";
							setJoinHover(true);
						}}
						onDrop={(e: ReactDragEvent) => {
							setJoinHover(false);
							if (!(canJoin && dnd.draggingId)) {
								return;
							}
							e.preventDefault();
							e.stopPropagation();
							addTabToSplit(split.id, dnd.draggingId);
							dnd.onEnd();
						}}
					>
						<HugeiconsIcon className="size-3" icon={Folder01Icon} />
						<span className="font-medium text-xs">
							{canJoin && joinHover
								? "Drop to add"
								: `${label} · ${formatCount(members.length) ?? "—"}`}
						</span>
						<button
							className="ml-auto rounded px-1 text-muted-foreground text-xs hover:text-foreground"
							onClick={() => unsplit(members[0]?.id ?? "")}
							type="button"
						>
							Unsplit
						</button>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuRadioGroup
						onValueChange={(value) =>
							setSplitOrientation(split.id, value as SplitOrientation)
						}
						value={split.root.orientation}
					>
						<ContextMenuRadioItem value="columns">
							Side by side
						</ContextMenuRadioItem>
						<ContextMenuRadioItem value="rows">Stacked</ContextMenuRadioItem>
					</ContextMenuRadioGroup>
					<ContextMenuSeparator />
					<SplitPresetMenuItems split={split} />
					<ContextMenuSeparator />
					<ContextMenuItem onClick={() => unsplit(members[0]?.id ?? "")}>
						<HugeiconsIcon className="mr-2 size-4" icon={GridIcon} />
						Unsplit
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
			{ordered.map((tab) => (
				<VerticalTabRow
					isActive={tab.id === activeTabId}
					key={tab.id}
					tab={tab}
				/>
			))}
		</div>
	);
}

/** Vertical list of open tabs (Zen-style). Only rendered when the tab layout is
    "vertical"; in that mode the horizontal title-bar strip is hidden. Tabs are
    already normalized so grouped/split members render contiguously. */
function TabsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const { tabs, splits, activeTabId, openTab } = useTabsContext();
	// Bracket contiguous split runs (tabs are normalized, so members are always
	// adjacent) the way the horizontal strip does; everything else stays a row.
	const items: ReactNode[] = [];
	let i = 0;
	while (i < tabs.length) {
		const tab = tabs[i];
		const split = tab.splitId
			? splits.find((s) => s.id === tab.splitId)
			: undefined;
		if (split) {
			const members: Tab[] = [];
			while (i < tabs.length && tabs[i].splitId === split.id) {
				members.push(tabs[i]);
				i += 1;
			}
			items.push(
				<VerticalSplitBlock
					activeTabId={activeTabId}
					key={split.id}
					members={members}
					split={split}
				/>
			);
		} else {
			items.push(
				<VerticalTabRow
					isActive={tab.id === activeTabId}
					key={tab.id}
					tab={tab}
				/>
			);
			i += 1;
		}
	}
	return (
		<SidebarSection
			action={
				<SectionAddButton
					onClick={() => openTab("/chat", { forceNew: true })}
					title="New tab"
				/>
			}
			collapsed={collapsed}
			dnd={dnd}
			icon={GridIcon}
			label="Tabs"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="tabs"
			sort={sort}
		>
			{tabs.length === 0 ? (
				<p className="px-2 py-2 text-muted-foreground text-xs">No tabs open</p>
			) : (
				<SidebarMenu className="gap-0.5">{items}</SidebarMenu>
			)}
		</SidebarSection>
	);
}

/** The newest direct conversation each agent appears in, keyed by agent id.
 *
 *  Group conversations have their own group-chat row in Sessions. Keeping them
 *  out here prevents one council/team thread from being duplicated under every
 *  participating bot while preserving the direct-chat preview on each bot row.
 */
function latestConversationByAgent(
	convs: Conversation[]
): Map<string, Conversation> {
	const out = new Map<string, Conversation>();
	const stampOf = (c: Conversation) => toEpoch(c.lastMessageAt ?? c.updatedAt);
	for (const conv of convs) {
		if (conv.archived || isGroupConversation(conv)) {
			continue;
		}
		const ids = conversationParticipantIds(conv);
		for (const id of ids) {
			const existing = out.get(id);
			if (!existing || stampOf(existing) < stampOf(conv)) {
				out.set(id, conv);
			}
		}
	}
	return out;
}

/** The right-aligned stamp on a messaging-style row: a clock time today, a
 *  weekday inside the last week, a short date beyond that — the shape every
 *  messaging app uses. Buckets come from `dateBucketKey` so this and the Chats
 *  section can never disagree about where "yesterday" ends. */
function messagingRowStamp(ts: number): string {
	switch (dateBucketKey(ts, startOfTodayMs())) {
		case "today":
			return formatTime(ts, {
				hour: "numeric",
				minute: "2-digit",
			});
		case "yesterday":
			return "Yesterday";
		case "last-week":
			return formatDate(ts, { weekday: "short" });
		default:
			return formatDate(ts, {
				day: "2-digit",
				month: "2-digit",
				year: "2-digit",
			});
	}
}

/** The inside of a messaging-style agent row: a two-line-tall avatar, the name
 *  and last-activity stamp on the first line, and a one-line preview of the
 *  newest message below — the WhatsApp/Telegram shape.
 *
 *  The preview is whatever Core returned on the conversation summary; a fresh
 *  agent with no threads yet shows a muted placeholder rather than an empty
 *  second line, so every row keeps the same height. */
export function MessagingAgentRowBody({
	agent,
	conversation,
	loadMessages,
	nodeUrl,
	onEdit,
	onToggleThreads,
	showEdit = true,
	threadsExpanded,
	threadCount,
	usageBarVisible,
}: {
	agent: AgentSummary;
	conversation: Conversation | undefined;
	loadMessages?: ChatRowHandlers["loadMessages"];
	nodeUrl?: string;
	onEdit: () => void;
	onToggleThreads: () => void;
	showEdit?: boolean;
	threadsExpanded: boolean;
	threadCount: number;
	usageBarVisible: boolean;
}) {
	// Subscribes to the display time zone so the stamp repaints the moment it
	// changes; `messagingRowStamp` reads the zone at call time.
	useTimezoneRevision();
	const stampAt = conversation?.lastMessageAt ?? conversation?.updatedAt;
	const stamp = stampAt ? messagingRowStamp(toEpoch(stampAt)) : null;
	const conversationStatus = conversationRunStatusMeta(conversation?.runStatus);
	const previewStates = buildSidebarConversationPreviewStates({
		lastMessage: conversation?.lastMessage,
		lastMessageRole: conversation?.lastMessageRole,
		statusLabel: conversationStatus?.label,
		statusVisible:
			conversationStatus?.isRunning || conversationStatus?.needsAttention,
	});

	return (
		<>
			{conversation && nodeUrl ? (
				<SidebarTodoProgress
					conversation={conversation}
					loadMessages={loadMessages}
					nodeUrl={nodeUrl}
				/>
			) : null}
			<AgentAvatar
				className="size-9 shrink-0 rounded-full object-cover"
				engine={engineForAgent(agent)}
				glyph={agent.avatarGlyph}
				size="36px"
			/>
			<div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
				<div className="flex min-w-0 items-center gap-2">
					<OverflowTooltip
						className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-sm"
						fade
						text={agent.name}
					/>
					<AgentTitleBadge title={agent.title} />
					{usageBarVisible ? (
						<UsageBar
							agentId={agent.id}
							className="shrink-0"
							visible={usageBarVisible}
						/>
					) : null}
					{stamp ? (
						<span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
							{stamp}
						</span>
					) : null}
				</div>
				<div className="flex min-w-0 items-center gap-2">
					<SidebarConversationPreview
						className={`flex-1 ${conversation?.lastMessage ? "" : "italic"}`}
						states={previewStates}
						testId={`agent-chat-preview-${agent.id}`}
					/>
					{threadCount > 0 ? (
						<button
							aria-expanded={threadsExpanded}
							aria-label={`${threadsExpanded ? "Hide" : "Show"} ${threadCount} thread${threadCount === 1 ? "" : "s"} for ${agent.name}`}
							className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-colors hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
							onClick={(e) => {
								e.stopPropagation();
								onToggleThreads();
							}}
							title={`${threadsExpanded ? "Hide" : "Show"} ${threadCount} thread${threadCount === 1 ? "" : "s"}`}
							type="button"
						>
							<HugeiconsIcon
								className={`size-3 transition-transform ${threadsExpanded ? "" : "-rotate-90"}`}
								icon={ArrowDown01Icon}
							/>
						</button>
					) : null}
					{showEdit && (
						<Tooltip>
							<TooltipTrigger
								render={
									<button
										aria-label={`Edit ${agent.name}`}
										className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
										onClick={(e) => {
											e.stopPropagation();
											onEdit();
										}}
										type="button"
									>
										<HugeiconsIcon icon={PencilEdit01Icon} size={14} />
									</button>
								}
							/>
							<TooltipContent>Edit agent</TooltipContent>
						</Tooltip>
					)}
				</div>
			</div>
		</>
	);
}

/** A branch-tree list beneath one bot in Bot mode. Forked conversations are
 *  ordinary Core summaries, so a new fork appears here as soon as the history
 *  context receives the fork response; no second thread registry is needed. */
export function AgentThreadList({
	loadMessages,
	nodeUrl,
	onOpen,
	pageSize,
	threads,
	unreadIds,
}: {
	loadMessages?: ChatRowHandlers["loadMessages"];
	nodeUrl?: string;
	onOpen: (conversationId: string) => void;
	pageSize: number;
	threads: Conversation[];
	unreadIds?: Set<string>;
}) {
	const paged = usePaged(threads, pageSize);
	const renderList = (list: Conversation[]) => (
		<div className="relative ml-5 border-sidebar-border/70 border-l pl-2">
			<SidebarMenu className="gap-0.5">
				{list.map((thread) => {
					const forked = isForkedConversation(thread);
					const preview = thread.lastMessage?.trim();
					return (
						<SidebarMenuItem key={thread.id}>
							<button
								aria-label={`Open thread: ${thread.title}`}
								className="group/thread relative flex min-h-9 w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
								onClick={() => onOpen(thread.id)}
								type="button"
							>
								{nodeUrl ? (
									<SidebarTodoProgress
										celebrate={unreadIds?.has(thread.id) === true}
										conversation={thread}
										loadMessages={loadMessages}
										nodeUrl={nodeUrl}
									/>
								) : null}
								<span
									aria-hidden="true"
									className="absolute top-1/2 -left-[5px] size-2 -translate-y-1/2 rounded-full bg-sidebar-foreground/35 ring-2 ring-sidebar"
								/>
								<HugeiconsIcon
									className={`size-3.5 shrink-0 ${forked ? "text-primary" : "text-muted-foreground"}`}
									icon={GitBranchIcon}
								/>
								<span className="min-w-0 flex-1">
									<span className="flex min-w-0 items-center gap-1.5">
										<span className="min-w-0 flex-1 truncate text-foreground/85 text-xs">
											<AnimatedTitle text={thread.title} />
										</span>
										<span className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums">
											{compactAge(thread.updatedAt)}
										</span>
									</span>
									{preview ? (
										<span className="mt-0.5 block truncate text-[10px] text-muted-foreground/70">
											{preview}
										</span>
									) : null}
								</span>
							</button>
						</SidebarMenuItem>
					);
				})}
			</SidebarMenu>
		</div>
	);

	return (
		<div className="mt-0.5" data-testid="agent-thread-list">
			<div className="flex items-center gap-1.5 px-2 py-1 pl-7 text-[11px] text-muted-foreground">
				<HugeiconsIcon
					className="size-3 text-primary/75"
					icon={GitBranchIcon}
				/>
				<span className="font-medium">Threads</span>
				<span className="tabular-nums">
					{formatCount(threads.length) ?? "—"}
				</span>
			</div>
			{renderList(paged.visible)}
			<SectionPagingControls
				overflow={{
					getSearchText: (thread) => thread.title,
					items: paged.items,
					label: "threads",
					renderList,
				}}
				paged={paged}
			/>
		</div>
	);
}

/** Agents list in the sidebar — single-line rows, each with the Ryu logo. */
function AgentsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const { openCreateAgent } = useCreateAgentDialog();
	const { openTab } = useTabsContext();
	const { agents, loading } = useAgents();
	// App-contributed rows anchored to `agent`. The sidebar is where agents are
	// listed, so an app anchoring here previously had its row reachable only from
	// an agent TAB's menu — the one surface you have to already be on the agent to
	// see. Same factory the tab menu uses, so the two cannot drift.
	const agentContributedRows = useContributedRowsFor("agent", "agent_id");
	const usageBarPrefs = useUsageBarPrefs();
	const rowStyle = useAgentRowStyle();
	const messaging = rowStyle === "messaging";
	const { favorites, toggle: toggleFavorite } = useFavorites();
	const { conversations, loadMessages } = useChatHistoryContext();
	const activeNode = useActiveNode();
	const unreadIds = useConversationFlagsStore((state) => state.unreadIds);
	const pinnedAgents = useMemo(() => {
		const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
		return favorites
			.filter((favorite) => favorite.type === "agent")
			.map((favorite) => agentsById.get(favorite.id))
			.filter((agent): agent is AgentSummary => agent !== undefined);
	}, [agents, favorites]);
	const pinnedAgentIds = useMemo(
		() => new Set(pinnedAgents.map((agent) => agent.id)),
		[pinnedAgents]
	);
	// Bot mode gives pinned agents their own visual priority shelf. In every other
	// sidebar arrangement the regular agent list remains complete, so a pin never
	// makes an agent disappear just because the user left Bot mode.
	const listedAgents = messaging
		? agents.filter((agent) => !pinnedAgentIds.has(agent.id))
		: agents;
	// Only the messaging rows read this, and it walks every conversation — skip
	// the work entirely while the compact rows are on.
	const latestByAgent = useMemo(
		() =>
			messaging
				? latestConversationByAgent(conversations)
				: new Map<string, Conversation>(),
		[messaging, conversations]
	);
	const directThreadsByAgent = useMemo(
		() =>
			new Map(
				agents.map((agent) => [
					agent.id,
					directAgentThreads(agent.id, conversations),
				])
			),
		[agents, conversations]
	);
	const [expandedAgentIds, setExpandedAgentIds] = useState<Set<string>>(
		new Set()
	);
	const paged = usePaged(
		sortItems(listedAgents, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const openAgent = (id: string, name: string, forceNew = false) => {
		const agent = agents.find((a) => a.id === id);
		openTab(`/agents/${id}/edit`, {
			title: name,
			forceNew,
			icon:
				agent?.avatarGlyph ?? personaToGlyph({ avatarUrl: agent?.avatarUrl }),
		});
	};

	const openAgentInNewWindow = (id: string, name: string) => {
		void openEntityInNewWindow({ path: `/agents/${id}/edit`, title: name });
	};

	// Start a fresh chat with this agent pre-selected (ChatPage reads initialAgent).
	//
	// Messaging rows open the merged view instead: one scroll holding every thread
	// with this agent, the way tapping a contact does. That path is a singleton per
	// agent, so tapping the same agent twice returns to the same tab rather than
	// piling up empty chats.
	const startChatWithAgent = (id: string) => {
		const agent = agents.find((a) => a.id === id);
		const icon =
			agent?.avatarGlyph ?? personaToGlyph({ avatarUrl: agent?.avatarUrl });
		if (messaging) {
			openTab(`/chat/agent/${encodeURIComponent(id)}`, {
				title: agent?.name,
				icon,
			});
			return;
		}
		openTab("/chat", {
			forceNew: true,
			initialAgent: id,
			icon,
		});
	};

	const toggleAgentThreads = (agentId: string) => {
		setExpandedAgentIds((current) => {
			const next = new Set(current);
			if (next.has(agentId)) {
				next.delete(agentId);
			} else {
				next.add(agentId);
			}
			return next;
		});
	};

	const openThread = (conversationId: string) => {
		openTab("/chat", { conversationId });
	};

	const emptyMessage = loading ? "Loading…" : "No agents yet";

	const renderAgentRows = (list: typeof agents) =>
		list.map((agent) => {
			const threads = directThreadsByAgent.get(agent.id) ?? [];
			const threadsExpanded = expandedAgentIds.has(agent.id);
			return (
				<SidebarMenuItem key={agent.id}>
					<ContextMenu>
						<ContextMenuTrigger>
							{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
							<div
								className={
									messaging
										? "group/row relative flex cursor-pointer items-center gap-2.5 overflow-hidden rounded-md px-2 py-1.5 transition-colors hover:bg-muted"
										: "group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
								}
								onAuxClick={(e) => {
									if (e.button === 1) {
										e.preventDefault();
										openAgent(agent.id, agent.name, true);
									}
								}}
								onClick={() => startChatWithAgent(agent.id)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										startChatWithAgent(agent.id);
									}
								}}
								role="button"
								tabIndex={0}
							>
								{messaging ? (
									<MessagingAgentRowBody
										agent={agent}
										conversation={latestByAgent.get(agent.id)}
										loadMessages={loadMessages}
										nodeUrl={activeNode.url}
										onEdit={() => openAgent(agent.id, agent.name)}
										onToggleThreads={() => toggleAgentThreads(agent.id)}
										threadCount={threads.length}
										threadsExpanded={threadsExpanded}
										usageBarVisible={usageBarPrefs.sidebar}
									/>
								) : (
									<>
										<AgentAvatar
											className="size-4 shrink-0 rounded-[3px] object-contain"
											engine={engineForAgent(agent)}
											glyph={agent.avatarGlyph}
											size="16px"
										/>
										<div className="flex min-w-0 shrink items-center gap-1.5">
											<OverflowTooltip
												className="min-w-0 overflow-hidden whitespace-nowrap text-sm"
												fade
												text={agent.name}
											/>
											<AgentTitleBadge title={agent.title} />
										</div>
										{usageBarPrefs.sidebar ? (
											<UsageBar
												agentId={agent.id}
												className="shrink-0"
												visible={usageBarPrefs.sidebar}
											/>
										) : null}
										<div aria-hidden="true" className="flex-1" />
										<Tooltip>
											<TooltipTrigger
												render={
													<button
														aria-label={`Edit ${agent.name}`}
														className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
														onClick={(e) => {
															e.stopPropagation();
															openAgent(agent.id, agent.name);
														}}
														type="button"
													>
														<HugeiconsIcon icon={PencilEdit01Icon} size={14} />
													</button>
												}
											/>
											<TooltipContent>Edit agent</TooltipContent>
										</Tooltip>
									</>
								)}
							</div>
						</ContextMenuTrigger>
						<ContextMenuContent>
							<ContextMenuItem
								onClick={() => openAgent(agent.id, agent.name, true)}
							>
								<HugeiconsIcon
									className="mr-2 size-4"
									icon={ArrowUpRight01Icon}
								/>
								Open in new tab
							</ContextMenuItem>
							<OpenInNewWindowContextMenuItem
								onClick={() => openAgentInNewWindow(agent.id, agent.name)}
							/>
							<ContextMenuItem
								onClick={() => toggleFavorite("agent", agent.id)}
							>
								<HugeiconsIcon
									className="mr-2 size-4"
									icon={pinnedAgentIds.has(agent.id) ? PinOffIcon : PinIcon}
								/>
								{pinnedAgentIds.has(agent.id) ? "Unpin agent" : "Pin agent"}
							</ContextMenuItem>
							{agentContributedRows(agent.id).map((row) => (
								<ContextMenuItem key={row.id} onClick={row.onSelect}>
									<span className="mr-2 inline-flex">
										<EntityRowGlyph row={row} />
									</span>
									{row.label}
								</ContextMenuItem>
							))}
						</ContextMenuContent>
					</ContextMenu>
					{messaging && threadsExpanded ? (
						<AgentThreadList
							loadMessages={loadMessages}
							nodeUrl={activeNode.url}
							onOpen={openThread}
							pageSize={pageSize}
							threads={threads}
							unreadIds={unreadIds}
						/>
					) : null}
				</SidebarMenuItem>
			);
		});

	return (
		<SidebarSection
			action={
				<SectionAddButton onClick={() => openCreateAgent()} title="New agent" />
			}
			collapsed={collapsed}
			dnd={dnd}
			label="Agents"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="agents"
			sort={sort}
		>
			{agents.length === 0 ? (
				<p className="px-2 py-2 text-muted-foreground text-xs">
					{emptyMessage}
				</p>
			) : (
				<>
					{messaging ? (
						<PinnedAgentStage
							agents={pinnedAgents}
							onEdit={(agent) => openAgent(agent.id, agent.name)}
							onOpen={(agent) => startChatWithAgent(agent.id)}
							onUnpin={(agent) => toggleFavorite("agent", agent.id)}
						/>
					) : null}
					{messaging && pinnedAgents.length > 0 && listedAgents.length > 0 ? (
						<div className="px-2 py-1 text-[10px] text-muted-foreground/70 uppercase tracking-[0.1em]">
							Other agents
						</div>
					) : null}
					{listedAgents.length > 0 ? (
						<>
							<SidebarMenu className="gap-0.5">
								{renderAgentRows(paged.visible)}
							</SidebarMenu>
							<SectionPagingControls
								overflow={{
									getSearchText: (agent) => agent.name ?? "",
									items: paged.items,
									label: "agents",
									renderList: (list) => (
										<SidebarMenu className="gap-0.5">
											{renderAgentRows(list)}
										</SidebarMenu>
									),
								}}
								paged={paged}
							/>
						</>
					) : null}
				</>
			)}
		</SidebarSection>
	);
}

/** A section's load-failure body: a plain-English line plus a "Try again"
 *  affordance. Shown instead of the empty-state when a fetch fails, so a failed
 *  load never masquerades as "nothing here yet". */
function SectionLoadError({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) {
	return (
		<div className="flex flex-col items-start gap-1 px-2 py-2">
			<p className="text-muted-foreground text-xs">{message}</p>
			<button
				className="text-primary text-xs hover:underline"
				onClick={onRetry}
				type="button"
			>
				Try again
			</button>
		</div>
	);
}

/**
 * The picker's document list: every space's pages, databases and files at once, or
 * just the selected space's.
 *
 * "All spaces" is an AGGREGATE fetch — one `listDocuments` per space, in parallel —
 * because Core has no cross-space document endpoint. Three things keep that from
 * being reckless. It only mounts while the section is EXPANDED (`SidebarSection`
 * does not render collapsed children), so a collapsed section still costs nothing.
 * A per-space failure degrades to "no documents from that space" rather than
 * failing the whole list. And the result is PAGED before it renders: the Uploads
 * system space alone accumulates every chat attachment and editor paste ever made
 * on this node, so an unpaged aggregate would put thousands of rows in the sidebar.
 * That last point is also why paging wraps the date-bucketed path here, unlike the
 * Chats section — there, the bucketed set is bounded by the chat list itself.
 */
export function SpacesPickerBody({
	listDocuments,
	onOpenDoc,
	onOpenInNewWindow,
	pageSize,
	setDocumentIcon,
	sort,
	spaces,
}: {
	listDocuments: (spaceId: string) => Promise<SpaceDocument[]>;
	onOpenDoc: (doc: SpaceDocument, forceNew?: boolean) => void;
	onOpenInNewWindow?: (doc: SpaceDocument) => void;
	pageSize: number;
	setDocumentIcon: (
		spaceId: string,
		documentId: string,
		icon: GlyphValue
	) => Promise<void>;
	sort: SortKey;
	/** The spaces in scope: one, or all of them. */
	spaces: Space[];
}) {
	const [groupByDate] = useChatDateGrouping();
	const [docs, setDocs] = useState<SpaceDocument[]>([]);
	const [loading, setLoading] = useState(true);
	const listRef = useRef(listDocuments);
	listRef.current = listDocuments;
	// `useSpaces` re-runs through `useCoreRefresh`, so the `spaces` ARRAY identity
	// churns even when its contents did not. Depending on the joined ids instead
	// keeps this from re-fetching every list on every refresh tick.
	const spaceIds = spaces.map((s) => s.id).join(",");

	useEffect(() => {
		let cancelled = false;
		const ids = spaceIds ? spaceIds.split(",") : [];
		if (ids.length === 0) {
			setDocs([]);
			setLoading(false);
			return;
		}
		setLoading(true);
		Promise.all(
			ids.map((id) => listRef.current(id).catch(() => [] as SpaceDocument[]))
		)
			.then((lists) => {
				if (!cancelled) {
					setDocs(lists.flat());
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [spaceIds]);

	// Newest-first across the union, so a mixed list reads chronologically rather
	// than space-by-space; `sort` then re-orders it if the user picked an option.
	const ordered = useMemo(
		() => [...docs].sort((a, b) => toEpoch(b.createdAt) - toEpoch(a.createdAt)),
		[docs]
	);
	const paged = usePaged(
		sortItems(ordered, sort, SPACE_DOC_SORT_ACCESSORS),
		pageSize
	);

	const applyIcon = (docId: string, icon: GlyphValue) =>
		setDocs((prev) => prev.map((d) => (d.id === docId ? { ...d, icon } : d)));

	const renderRows = (list: SpaceDocument[]) => (
		<SpaceDocRows
			docs={list}
			onIconChanged={applyIcon}
			onOpenDoc={onOpenDoc}
			onOpenInNewWindow={onOpenInNewWindow}
			setDocumentIcon={setDocumentIcon}
		/>
	);

	if (loading) {
		return <p className="px-2 py-2 text-muted-foreground text-xs">Loading…</p>;
	}
	if (ordered.length === 0) {
		return (
			<p className="px-2 py-2 text-muted-foreground text-xs">No pages yet</p>
		);
	}

	return (
		<>
			{groupByDate ? (
				<DateGroupedRows
					className="ml-2 space-y-0.5"
					collapsedKey={
						dateBucketStorageKeys(`spaces-picker:${spaceIds}`).collapsedKey
					}
					items={paged.visible}
					// Remount when the scope changes — see the same `key` on
					// {@link SidebarChatList} for why.
					key={spaceIds}
					orderKey={dateBucketStorageKeys(`spaces-picker:${spaceIds}`).orderKey}
					renderRows={renderRows}
					stampOf={spaceDocumentStamp}
				/>
			) : (
				renderRows(paged.visible)
			)}
			<SectionPagingControls
				overflow={{
					getSearchText: (d) => d.title ?? "",
					items: paged.items,
					label: "pages",
					renderList: renderRows,
				}}
				paged={paged}
			/>
		</>
	);
}

/** Spaces list in the sidebar — mirrors Agents; rows open the Spaces tab.
 *  The "+" opens the create dialog inline (shared with the Spaces page via the
 *  SpacesProvider), so a new space appears here and in the page immediately. */
/**
 * A run of space documents as sidebar rows.
 *
 * Space-AGNOSTIC on purpose: every row routes through its own `doc.spaceId` rather
 * than a `spaceId` passed alongside, which is what lets the per-space list and the
 * picker's "All spaces" list (documents from many spaces interleaved) render the
 * identical row instead of growing a second copy that drifts.
 */
function SpaceDocRows({
	docs,
	onIconChanged,
	onOpenDoc,
	onOpenInNewWindow,
	setDocumentIcon,
}: {
	docs: SpaceDocument[];
	/** Let the owner of the list apply the new icon optimistically. */
	onIconChanged: (docId: string, icon: GlyphValue) => void;
	onOpenDoc: (doc: SpaceDocument, forceNew?: boolean) => void;
	onOpenInNewWindow?: (doc: SpaceDocument) => void;
	setDocumentIcon: (
		spaceId: string,
		documentId: string,
		icon: GlyphValue
	) => Promise<void>;
}) {
	const { updateTabsIconWhere } = useTabsContext();
	const [iconTarget, setIconTarget] = useState<SpaceDocument | null>(null);
	return (
		<>
			<SidebarMenu className="gap-0.5">
				{docs.map((doc) => (
					<SidebarMenuItem key={doc.id}>
						<ContextMenu>
							<ContextMenuTrigger>
								<button
									className="flex h-7 w-full items-center gap-2 rounded-md pr-2 pl-8 text-left transition-colors hover:bg-muted"
									onAuxClick={(e) => {
										if (e.button === 1) {
											e.preventDefault();
											onOpenDoc(doc, true);
										}
									}}
									onClick={() => onOpenDoc(doc)}
									type="button"
								>
									<GlyphDisplay
										className="shrink-0 text-muted-foreground"
										fallback={
											<HugeiconsIcon
												className="size-3 shrink-0 text-muted-foreground"
												icon={
													doc.kind === "database" ? DatabaseIcon : File01Icon
												}
											/>
										}
										size={12}
										value={doc.icon}
									/>
									<OverflowTooltip
										className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-muted-foreground text-xs"
										fade
										text={doc.title}
									/>
								</button>
							</ContextMenuTrigger>
							<ContextMenuContent>
								<ContextMenuItem onClick={() => onOpenDoc(doc, true)}>
									<HugeiconsIcon
										className="mr-2 size-4"
										icon={ArrowUpRight01Icon}
									/>
									Open in new tab
								</ContextMenuItem>
								{onOpenInNewWindow ? (
									<OpenInNewWindowContextMenuItem
										onClick={() => onOpenInNewWindow(doc)}
									/>
								) : null}
								<ContextMenuItem onClick={() => setIconTarget(doc)}>
									<HugeiconsIcon
										className="mr-2 size-4"
										icon={ImageAdd01Icon}
									/>
									Change icon…
								</ContextMenuItem>
							</ContextMenuContent>
						</ContextMenu>
					</SidebarMenuItem>
				))}
			</SidebarMenu>
			{iconTarget ? (
				<EntityIconDialog
					description={iconTarget.title}
					onChange={(next) => {
						const docId = iconTarget.id;
						const spaceId = iconTarget.spaceId;
						onIconChanged(docId, next);
						updateTabsIconWhere(
							(t) =>
								t.path === `/spaces/${spaceId}/doc/${docId}` ||
								t.path === `/spaces/${spaceId}/db/${docId}`,
							next
						);
						void setDocumentIcon(spaceId, docId, next).catch(() => {
							toast.error("Couldn't update page icon");
						});
					}}
					onOpenChange={(open) => {
						if (!open) {
							setIconTarget(null);
						}
					}}
					open
					title="Page icon"
					value={iconTarget.icon}
				/>
			) : null}
		</>
	);
}

/** Lazily-loaded list of a space's pages & databases, shown indented under its
 *  row (mirrors SidebarSideChats). Only mounted while the row is expanded, so
 *  collapsed rows never hit Core. Each entry opens its editor tab. Date-bucketed
 *  when the user's "Group lists by date" setting is on — which is how the Uploads
 *  space, the one that accumulates every attachment, becomes scannable. */
function SidebarSpaceDocs({
	spaceId,
	listDocuments,
	onOpenDoc,
	onOpenInNewWindow,
	setDocumentIcon,
}: {
	listDocuments: (spaceId: string) => Promise<SpaceDocument[]>;
	onOpenDoc: (doc: SpaceDocument, forceNew?: boolean) => void;
	onOpenInNewWindow?: (doc: SpaceDocument) => void;
	setDocumentIcon: (
		spaceId: string,
		documentId: string,
		icon: GlyphValue
	) => Promise<void>;
	spaceId: string;
}) {
	const [groupByDate] = useChatDateGrouping();
	const [docs, setDocs] = useState<SpaceDocument[]>([]);
	const [loading, setLoading] = useState(true);
	const listRef = useRef(listDocuments);
	listRef.current = listDocuments;

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		listRef
			.current(spaceId)
			.then((list) => {
				if (!cancelled) {
					setDocs(list);
				}
			})
			.catch(() => {
				/* treated as no documents */
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [spaceId]);

	const applyIcon = (docId: string, icon: GlyphValue) =>
		setDocs((prev) => prev.map((d) => (d.id === docId ? { ...d, icon } : d)));

	const renderRows = (list: SpaceDocument[]) => (
		<SpaceDocRows
			docs={list}
			onIconChanged={applyIcon}
			onOpenDoc={onOpenDoc}
			onOpenInNewWindow={onOpenInNewWindow}
			setDocumentIcon={setDocumentIcon}
		/>
	);

	if (loading) {
		return <p className="py-1 pl-8 text-muted-foreground text-xs">Loading…</p>;
	}
	if (docs.length === 0) {
		return (
			<p className="py-1 pl-8 text-muted-foreground text-xs">No pages yet</p>
		);
	}
	if (!groupByDate) {
		return renderRows(docs);
	}
	// `ml-6` rather than the Chats buckets' `ml-2`: these rows are already indented
	// to `pl-8` under their space, so a bucket header at the section indent would
	// float far to the left of what it introduces.
	return (
		<DateGroupedRows
			className="ml-6 space-y-0.5"
			collapsedKey={dateBucketStorageKeys(`space:${spaceId}`).collapsedKey}
			items={docs}
			orderKey={dateBucketStorageKeys(`space:${spaceId}`).orderKey}
			renderRows={renderRows}
			stampOf={spaceDocumentStamp}
		/>
	);
}

/** A single space row. Clicking the row toggles an indented list of its pages &
 *  databases (like a project folder expands to its chats); right-click opens the
 *  space page or deletes it. */
export function SpaceSidebarRow({
	space,
	appIcon,
	listDocuments,
	onAdd,
	onOpen,
	onOpenDocInNewWindow,
	onOpenInNewTab,
	onOpenDoc,
	onOpenInNewWindow,
	onRequestDelete,
	onRename,
	onRequestVisibilityChange,
	canDelete,
	canMakePrivate,
	setDocumentIcon,
	setSpaceIcon,
}: {
	/** Icon id registered by the space's owning app (Iconify/icons0/Hugeicons id),
	 *  resolved through the shared <Icon> primitive. Undefined for a plain
	 *  user-created space, which keeps the default glyph. */
	appIcon?: string;
	listDocuments: (spaceId: string) => Promise<SpaceDocument[]>;
	/** Open the add-to-space dialog for THIS space (upload / new page / new
	 *  database) — the hover "+" every other section's rows made people expect. */
	onAdd: () => void;
	onOpen: () => void;
	onOpenDoc: (doc: SpaceDocument, forceNew?: boolean) => void;
	onOpenDocInNewWindow: (doc: SpaceDocument) => void;
	onOpenInNewTab: () => void;
	onOpenInNewWindow: () => void;
	onRequestDelete: () => void;
	onRename: (name: string) => Promise<void>;
	onRequestVisibilityChange: (request: VisibilityChangeRequest) => void;
	canDelete: boolean;
	canMakePrivate: boolean;
	setDocumentIcon: (
		spaceId: string,
		documentId: string,
		icon: GlyphValue
	) => Promise<void>;
	setSpaceIcon: (id: string, icon: GlyphValue) => Promise<void>;
	space: Space;
}) {
	const { updateTabsIconWhere } = useTabsContext();
	// Contributed `space`-anchored rows — see the note in AgentsSection.
	const spaceContributedRows = useContributedRowsFor("space", "space_id");
	const [expanded, setExpanded] = useState(false);
	const [iconDialogOpen, setIconDialogOpen] = useState(false);
	const [renameOpen, setRenameOpen] = useState(false);
	const toggle = () => setExpanded((v) => !v);
	const visibilityGroup = resourceVisibilityGroup(
		space.visibility,
		space.system
	);
	const handleVisibilityDragStart = (event: ReactDragEvent<HTMLDivElement>) => {
		if (space.system) {
			return;
		}
		event.dataTransfer.effectAllowed = "move";
		const payload = serializeVisibilityDragPayload({
			from: visibilityGroup,
			id: space.id,
			name: space.name,
			resourceType: "space",
		});
		event.dataTransfer.setData(RESOURCE_VISIBILITY_DND_MIME, payload);
		event.dataTransfer.setData(resourceVisibilityDndMime("space"), "1");
		event.dataTransfer.setData("text/plain", payload);
	};
	const fallbackIcon = appIcon ? (
		<Icon
			className={`absolute inset-0 m-auto transition-opacity ${
				expanded ? "opacity-0" : "opacity-100 group-hover/row:opacity-0"
			}`}
			icon={appIcon}
			size={16}
		/>
	) : (
		<HugeiconsIcon
			className={`absolute inset-0 m-auto size-4 transition-opacity ${
				expanded ? "opacity-0" : "opacity-100 group-hover/row:opacity-0"
			}`}
			icon={DeliverySecure01Icon}
		/>
	);
	return (
		<SidebarMenuItem>
			<ContextMenu>
				<ContextMenuTrigger>
					{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
					<div
						className="group/row group/subsection flex h-8 cursor-grab items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted active:cursor-grabbing"
						draggable={!space.system}
						onAuxClick={(e) => {
							if (e.button === 1) {
								e.preventDefault();
								onOpenInNewTab();
							}
						}}
						onClick={toggle}
						onDragStart={handleVisibilityDragStart}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								toggle();
							}
						}}
						role="button"
						tabIndex={0}
					>
						{/* The space glyph doubles as the disclosure control: it shows the
						    space icon at rest and morphs to a chevron on hover / once
						    expanded, so the row reads as an expandable folder. */}
						<span className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground">
							{space.icon ? (
								<span
									className={`absolute inset-0 m-auto flex items-center justify-center transition-opacity ${
										expanded
											? "opacity-0"
											: "opacity-100 group-hover/row:opacity-0"
									}`}
								>
									<GlyphDisplay fallback={null} size={16} value={space.icon} />
								</span>
							) : (
								fallbackIcon
							)}
							<HugeiconsIcon
								className={`size-3 transition-all ${
									expanded
										? "opacity-100"
										: "-rotate-90 opacity-0 group-hover/row:opacity-100"
								}`}
								icon={ArrowDown01Icon}
							/>
						</span>
						<OverflowTooltip
							className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-sm"
							fade
							text={space.name}
						/>
						<ResourceVisibilityIndicator
							system={space.system}
							visibility={space.visibility}
						/>
						{/* Count and "+" share one slot, swapped on hover the same way the
						    glyph above swaps to its chevron — an h-8 row has no width for
						    both, and overlaying keeps the row from reflowing under the
						    pointer. The button stays mounted (opacity-driven, not
						    `hidden`) so it is still reachable by keyboard. */}
						<span className="relative flex min-w-5 shrink-0 items-center justify-center">
							<span className="text-muted-foreground/70 text-xs tabular-nums transition-opacity group-hover/row:opacity-0">
								{space.documentCount}
							</span>
							<span className="absolute inset-0 flex items-center justify-center">
								<SubSectionActionButton
									icon={Add01Icon}
									onClick={onAdd}
									title={`Add to ${space.name}`}
								/>
							</span>
						</span>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem onClick={onOpen}>
						<HugeiconsIcon
							className="mr-2 size-4"
							icon={DeliverySecure01Icon}
						/>
						Open space page
					</ContextMenuItem>
					<ContextMenuItem onClick={onOpenInNewTab}>
						<HugeiconsIcon className="mr-2 size-4" icon={ArrowUpRight01Icon} />
						Open in new tab
					</ContextMenuItem>
					<OpenInNewWindowContextMenuItem onClick={onOpenInNewWindow} />
					<ContextMenuItem onClick={() => setIconDialogOpen(true)}>
						<HugeiconsIcon className="mr-2 size-4" icon={ImageAdd01Icon} />
						Change icon…
					</ContextMenuItem>
					{space.system ? null : (
						<ContextMenuItem onClick={() => setRenameOpen(true)}>
							<HugeiconsIcon className="mr-2 size-4" icon={PencilEdit01Icon} />
							Rename space
						</ContextMenuItem>
					)}
					{space.system ? null : (
						<ContextMenuItem
							disabled={visibilityGroup === "team" && !canMakePrivate}
							onClick={() =>
								onRequestVisibilityChange({
									from: visibilityGroup,
									id: space.id,
									name: space.name,
									resourceType: "space",
									to: visibilityGroup === "team" ? "private" : "team",
								})
							}
						>
							<HugeiconsIcon
								className="mr-2 size-4"
								icon={
									resourceVisibilityGroup(space.visibility) === "team"
										? ViewOffSlashIcon
										: UserMultiple02Icon
								}
							/>
							{visibilityGroup === "team"
								? canMakePrivate
									? "Make private"
									: "Make private (admins only)"
								: "Share with team"}
						</ContextMenuItem>
					)}
					<ContextMenuSeparator />
					{/* A Ryu-owned system Space (Artifacts, Meetings, Uploads…) is a node
					    singleton Core refuses to delete — `SpaceStore::delete_space`
					    bails on `system = 1`, so offering the action here could only ever
					    produce the "Couldn't delete this space" toast. Disabled rather
					    than hidden: a menu that silently loses a row reads as a bug, and
					    the tooltip is where the reason belongs. The wrapper span carries
					    the tooltip because a disabled item is `pointer-events-none` and
					    would never see the hover itself. */}
					{space.system || !canDelete ? (
						<Tooltip>
							<TooltipTrigger render={<span className="block" />}>
								<ContextMenuItem disabled variant="destructive">
									<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
									Delete space
								</ContextMenuItem>
							</TooltipTrigger>
							<TooltipContent className="max-w-56">
								{space.system
									? "System spaces can't be deleted — Ryu creates and maintains this one."
									: "Only organization members with Space delete permission can delete Spaces."}
							</TooltipContent>
						</Tooltip>
					) : (
						<ContextMenuItem onClick={onRequestDelete} variant="destructive">
							<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
							Delete space
						</ContextMenuItem>
					)}
					{spaceContributedRows(space.id).map((row) => (
						<ContextMenuItem key={row.id} onClick={row.onSelect}>
							<span className="mr-2 inline-flex">
								<EntityRowGlyph row={row} />
							</span>
							{row.label}
						</ContextMenuItem>
					))}
				</ContextMenuContent>
			</ContextMenu>
			{expanded && (
				<SidebarSpaceDocs
					listDocuments={listDocuments}
					onOpenDoc={onOpenDoc}
					onOpenInNewWindow={onOpenDocInNewWindow}
					setDocumentIcon={setDocumentIcon}
					spaceId={space.id}
				/>
			)}
			<EntityIconDialog
				description={space.name}
				onChange={(next) => {
					updateTabsIconWhere((t) => t.path === `/spaces/${space.id}`, next);
					void setSpaceIcon(space.id, next).catch(() => {
						toast.error("Couldn't update space icon");
					});
				}}
				onOpenChange={setIconDialogOpen}
				open={iconDialogOpen}
				title="Space icon"
				value={space.icon}
			/>
			<RenameSpaceDialog
				onClose={() => setRenameOpen(false)}
				onRename={onRename}
				open={renameOpen}
				space={space}
			/>
		</SidebarMenuItem>
	);
}

function SpacesSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const { openTab } = useTabsContext();
	const {
		spaces,
		loading,
		error,
		reload,
		create,
		remove,
		rename,
		listDocuments,
		setSpaceIcon,
		setSpaceVisibility,
		setDocumentIcon,
	} = useSpacesContext();
	const { canMakePrivate } = useVisibilityAdminAccess();
	const canDeleteSpaces = useCanManagePermission("space.delete");
	const [pendingVisibility, setPendingVisibility] =
		useState<VisibilityChangeRequest | null>(null);
	const [changingVisibility, setChangingVisibility] = useState(false);
	const requestVisibilityChange = useCallback(
		(request: VisibilityChangeRequest) => {
			if (request.to === "private" && !canMakePrivate) {
				toast.error(
					"Only organization admins can make shared resources private"
				);
				return;
			}
			setPendingVisibility(request);
		},
		[canMakePrivate]
	);
	const confirmVisibilityChange = useCallback(async () => {
		if (!pendingVisibility) {
			return;
		}
		if (pendingVisibility.to === "private" && !canMakePrivate) {
			toast.error("Only organization admins can make shared resources private");
			return;
		}
		setChangingVisibility(true);
		try {
			await setSpaceVisibility(
				pendingVisibility.id,
				resourceVisibilityForGroup(pendingVisibility.to)
			);
			setPendingVisibility(null);
		} catch {
			toast.error("Couldn't change this Space's visibility", {
				description: "The Space stayed in its current group.",
			});
		} finally {
			setChangingVisibility(false);
		}
	}, [canMakePrivate, pendingVisibility, setSpaceVisibility]);
	const visibilityDropFor = (group: ResourceVisibilityGroup) => ({
		accept: "space" as const,
		canDrop: (_payload: VisibilityDragPayload) =>
			group !== "private" || canMakePrivate,
		canDropOnDragOver: () => group !== "private" || canMakePrivate,
		onDrop: (payload: VisibilityDragPayload) =>
			requestVisibilityChange({
				...payload,
				to: group,
			}),
	});
	const [createOpen, setCreateOpen] = useState(false);
	// The row "+" target. Held at section level, and the dialog below stays mounted
	// across `null`, so an upload started from one row keeps running (and keeps
	// reporting) if the user closes it — its queue lives in that component.
	const [addTargetId, setAddTargetId] = useState<string | null>(null);
	const [addOpen, setAddOpen] = useState(false);
	// Deleting a space is permanent, so the right-click Delete action opens a
	// confirmation dialog (rather than removing it outright); the pending target
	// is held here so the single shared dialog knows which space to delete.
	const [pendingDelete, setPendingDelete] = useState<{
		id: string;
		name: string;
	} | null>(null);
	const [deleting, setDeleting] = useState(false);
	// The "Meetings" system space is shown here as its own space (per request) — no
	// longer name-filtered out of the list.
	const visibleSpaces = spaces;
	const [groupedNav] = useSidebarGroupedNav();
	// The picker model has no space ROW to hang app-contributed actions off, so the
	// section resolves them itself and the scope menu renders them for the selection
	// — same rows a space row's context menu shows, same anchor.
	const spaceContributedRows = useContributedRowsFor("space", "space_id");
	const spacesByVisibility = useMemo(
		() =>
			visibleSpaces.reduce<Record<ResourceVisibilityGroup, Space[]>>(
				(groups, space) => {
					groups[resourceVisibilityGroup(space.visibility, space.system)].push(
						space
					);
					return groups;
				},
				{ private: [], team: [] }
			),
		[visibleSpaces]
	);
	const visibilityGroupKeys = useMemo(
		() => ["private", "team"] as ResourceVisibilityGroup[],
		[]
	);
	const visibilityGroups = useNestedSections(
		SPACE_VISIBILITY_ORDER_KEY,
		SPACE_VISIBILITY_COLLAPSED_KEY,
		visibilityGroupKeys,
		false
	);
	const privateOptions = useMemo(
		() =>
			spacesByVisibility.private.map((s) => ({ label: s.name, value: s.id })),
		[spacesByVisibility.private]
	);
	const teamOptions = useMemo(
		() => spacesByVisibility.team.map((s) => ({ label: s.name, value: s.id })),
		[spacesByVisibility.team]
	);
	const [privateSelection, setPrivateSelection] = usePickerSelection(
		"ryu:sidebar-private-space-selection",
		privateOptions
	);
	const [teamSelection, setTeamSelection] = usePickerSelection(
		"ryu:sidebar-team-space-selection",
		teamOptions
	);
	const selectedPrivateSpace =
		privateSelection === ALL_SELECTION
			? null
			: (spacesByVisibility.private.find((s) => s.id === privateSelection) ??
				null);
	const selectedTeamSpace =
		teamSelection === ALL_SELECTION
			? null
			: (spacesByVisibility.team.find((s) => s.id === teamSelection) ?? null);
	// Map an app companion's label → the icon id it registered, so a system space
	// (Canvas/Whiteboard/Meetings/…) shows its owning app's icon, resolved through
	// the shared <Icon> primitive. Data-driven off /api/plugins/contributions — no
	// hardcoded name→icon map in the shell. A space with no matching app keeps the
	// default glyph.
	const { companions } = usePluginContributions();
	const appIconBySpaceName = useMemo(() => {
		const map = new Map<string, string>();
		for (const companion of companions) {
			const key = (companion.label || companion.name)?.toLowerCase();
			if (key && companion.icon) {
				map.set(key, companion.icon);
			}
		}
		return map;
	}, [companions]);
	const privatePaged = usePaged(
		sortItems(spacesByVisibility.private, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);
	const teamPaged = usePaged(
		sortItems(spacesByVisibility.team, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const visibilityIcon = (group: ResourceVisibilityGroup) =>
		group === "private" ? ViewOffSlashIcon : UserMultiple02Icon;
	const visibilityLabel = (group: ResourceVisibilityGroup) =>
		group === "private" ? resourceVisibilityLabel("private") : "Team";

	const renderSpacePickerGroup = (group: ResourceVisibilityGroup) => {
		const groupSpaces = spacesByVisibility[group];
		const isPrivate = group === "private";
		const selection = isPrivate ? privateSelection : teamSelection;
		const setSelection = isPrivate ? setPrivateSelection : setTeamSelection;
		const selectedSpace = isPrivate ? selectedPrivateSpace : selectedTeamSpace;
		const shownSpaces =
			selection === ALL_SELECTION
				? groupSpaces
				: groupSpaces.filter((space) => space.id === selection);

		return (
			<SubSection
				collapsed={visibilityGroups.isCollapsed(group)}
				count={groupSpaces.length}
				dnd={visibilityGroups.dnd}
				icon={visibilityIcon(group)}
				key={group}
				label={visibilityLabel(group)}
				onToggleCollapsed={visibilityGroups.toggle}
				sectionKey={group}
				size="md"
				visibilityDrop={visibilityDropFor(group)}
			>
				<SidebarScopePicker
					actions={
						selectedSpace ? (
							<SpaceScopeMenu
								canDelete={canDeleteSpaces}
								canMakePrivate={canMakePrivate}
								contributedRows={spaceContributedRows(selectedSpace.id)}
								onAdd={() => {
									setAddTargetId(selectedSpace.id);
									setAddOpen(true);
								}}
								onOpen={() => openSpace(selectedSpace)}
								onOpenInNewTab={() => openSpace(selectedSpace, true)}
								onOpenInNewWindow={() => openSpaceInNewWindow(selectedSpace)}
								onRename={(name) => rename(selectedSpace.id, name)}
								onRequestDelete={() =>
									setPendingDelete({
										id: selectedSpace.id,
										name: selectedSpace.name,
									})
								}
								onRequestVisibilityChange={requestVisibilityChange}
								setSpaceIcon={setSpaceIcon}
								space={selectedSpace}
							/>
						) : undefined
					}
					allLabel={isPrivate ? "All private spaces" : "All team spaces"}
					icon={visibilityIcon(group)}
					onValueChange={setSelection}
					options={isPrivate ? privateOptions : teamOptions}
					value={selection}
				/>
				<SpacesPickerBody
					listDocuments={listDocuments}
					onOpenDoc={(doc, forceNew) => openDoc(doc.spaceId, doc, forceNew)}
					onOpenInNewWindow={openDocInNewWindow}
					pageSize={pageSize}
					setDocumentIcon={setDocumentIcon}
					sort={sort}
					spaces={shownSpaces}
				/>
			</SubSection>
		);
	};

	const renderSpaceRowsGroup = (group: ResourceVisibilityGroup) => {
		const groupPaged = group === "private" ? privatePaged : teamPaged;
		return (
			<SubSection
				collapsed={visibilityGroups.isCollapsed(group)}
				count={spacesByVisibility[group].length}
				dnd={visibilityGroups.dnd}
				icon={visibilityIcon(group)}
				key={group}
				label={visibilityLabel(group)}
				onToggleCollapsed={visibilityGroups.toggle}
				sectionKey={group}
				size="md"
				visibilityDrop={visibilityDropFor(group)}
			>
				<SidebarMenu className="gap-0.5">
					{renderSpaceRows(groupPaged.visible)}
				</SidebarMenu>
				<SectionPagingControls
					overflow={{
						getSearchText: (space) => space.name ?? "",
						items: groupPaged.items,
						label: `${visibilityLabel(group).toLowerCase()} spaces`,
						renderList: (list) => (
							<SidebarMenu className="gap-0.5">
								{renderSpaceRows(list)}
							</SidebarMenu>
						),
					}}
					paged={groupPaged}
				/>
			</SubSection>
		);
	};

	// Open a specific space's page (`/spaces/:id`), pre-selecting it — the Spaces
	// page no longer renders its own space list, so selection is driven from here.
	const openSpace = (space: (typeof visibleSpaces)[number], forceNew = false) =>
		openTab(`/spaces/${space.id}`, {
			title: space.name,
			forceNew,
			icon: space.icon ?? null,
		});

	const openSpaceInNewWindow = (space: (typeof visibleSpaces)[number]) => {
		void openEntityInNewWindow({
			path: `/spaces/${space.id}`,
			title: space.name,
		});
	};

	// Open a document inside a space directly in its editor (databases use the
	// data-grid route, pages the markdown route) — mirrors SpacesPage.openDoc.
	const openDoc = (spaceId: string, doc: SpaceDocument, forceNew = false) => {
		const segment =
			doc.rawKind === "file" ? "file" : doc.kind === "database" ? "db" : "doc";
		openTab(`/spaces/${spaceId}/${segment}/${doc.id}`, {
			title: doc.title || "Untitled",
			icon: doc.icon ?? null,
			forceNew,
		});
	};

	const openDocInNewWindow = (doc: SpaceDocument) => {
		const segment =
			doc.rawKind === "file" ? "file" : doc.kind === "database" ? "db" : "doc";
		void openEntityInNewWindow({
			path: `/spaces/${doc.spaceId}/${segment}/${doc.id}`,
			title: doc.title || "Untitled",
		});
	};

	const confirmDelete = async (): Promise<boolean> => {
		if (!pendingDelete) {
			return false;
		}
		const { id, name } = pendingDelete;
		setDeleting(true);
		try {
			await remove(id);
			setPendingDelete(null);
			return true;
		} catch {
			toast.error("Couldn't delete this space", {
				description: `"${name}" and its documents weren't deleted. Please try again.`,
			});
			return false;
		} finally {
			setDeleting(false);
		}
	};

	const emptyMessage = loading ? "Loading…" : "No spaces yet";

	const renderSpaceRows = (list: typeof visibleSpaces) =>
		list.map((space) => (
			<SpaceSidebarRow
				appIcon={appIconBySpaceName.get(space.name.toLowerCase())}
				canDelete={canDeleteSpaces}
				canMakePrivate={canMakePrivate}
				key={space.id}
				listDocuments={listDocuments}
				onAdd={() => {
					setAddTargetId(space.id);
					setAddOpen(true);
				}}
				onOpen={() => openSpace(space)}
				onOpenDoc={(doc, forceNew) => openDoc(space.id, doc, forceNew)}
				onOpenDocInNewWindow={openDocInNewWindow}
				onOpenInNewTab={() => openSpace(space, true)}
				onOpenInNewWindow={() => openSpaceInNewWindow(space)}
				onRename={(name) => rename(space.id, name)}
				onRequestDelete={() =>
					setPendingDelete({ id: space.id, name: space.name })
				}
				onRequestVisibilityChange={requestVisibilityChange}
				setDocumentIcon={setDocumentIcon}
				setSpaceIcon={setSpaceIcon}
				space={space}
			/>
		));
	const orderedVisibilityGroups = visibilityGroups.orderedKeys.filter(
		(key): key is ResourceVisibilityGroup => key === "private" || key === "team"
	);

	return (
		<>
			<SidebarSection
				action={
					<SectionAddButton
						onClick={() => setCreateOpen(true)}
						title="New space"
					/>
				}
				collapsed={collapsed}
				dnd={dnd}
				label="Spaces"
				menu={menu}
				onToggleCollapsed={onToggleCollapsed}
				pageSize={pageSize}
				sectionKey="spaces"
				sort={sort}
			>
				{error && visibleSpaces.length === 0 && (
					<SectionLoadError
						message="Couldn't load your spaces."
						onRetry={() => {
							reload().catch(() => undefined);
						}}
					/>
				)}
				{!error && visibleSpaces.length === 0 && (
					<p className="px-2 py-2 text-muted-foreground text-xs">
						{emptyMessage}
					</p>
				)}
				{visibleSpaces.length > 0 &&
					(groupedNav
						? orderedVisibilityGroups.map(renderSpacePickerGroup)
						: orderedVisibilityGroups.map(renderSpaceRowsGroup))}
			</SidebarSection>
			<CreateSpaceDialog
				onClose={() => setCreateOpen(false)}
				onCreate={create}
				open={createOpen}
			/>
			<AddToSpaceDialog
				onClose={() => setAddOpen(false)}
				open={addOpen}
				spaceId={addTargetId}
			/>
			<ResourceVisibilityConfirmationDialog
				canMakePrivate={canMakePrivate}
				changing={changingVisibility}
				onConfirm={() => {
					confirmVisibilityChange().catch(() => undefined);
				}}
				onOpenChange={(open) => {
					if (!(open || changingVisibility)) {
						setPendingVisibility(null);
					}
				}}
				request={pendingVisibility}
			/>
			<DestructiveConfirmDialog
				busy={deleting}
				description={
					pendingDelete
						? `"${pendingDelete.name}" and all its documents will be permanently deleted. This can't be undone.`
						: ""
				}
				label={`Delete ${pendingDelete?.name ?? "this Space"}`}
				onConfirm={confirmDelete}
				onOpenChange={(open) => {
					if (!(open || deleting)) {
						setPendingDelete(null);
					}
				}}
				open={pendingDelete !== null}
				title="Delete this Space?"
			/>
		</>
	);
}

/** Channels list in the sidebar — each row is a Telegram/Slack/WhatsApp/Discord
 *  bot. Rows open the channel manage page; "+" opens create. Hidden by default
 *  (opt-in feature). This is the picker; the manage tab is create/edit only. */
function ChannelsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const { channels, loading, authed, create, refresh } = useChannels();
	const { agents } = useAgents();
	const { teams } = useTeams();
	const { openTab } = useTabsContext();
	const {
		open: addDialogOpen,
		request: channelSetupRequest,
		setOpen: setAddDialogOpen,
	} = useChannelSetupDialog();
	const paged = usePaged(
		sortItems(channels, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const openChannel = (id: string, name: string, forceNew = false) =>
		openTab(`/channels/${id}`, { title: name, forceNew });

	let emptyMessage = "No channels yet";
	if (loading) {
		emptyMessage = "Loading…";
	} else if (!authed) {
		emptyMessage = "Sign in to add channels";
	}

	const renderChannelRows = (list: typeof channels) =>
		list.map((channel) => (
			<SidebarMenuItem key={channel.id}>
				<ContextMenu>
					<ContextMenuTrigger>
						{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
						<div
							className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									openChannel(channel.id, channel.name, true);
								}
							}}
							onClick={() => openChannel(channel.id, channel.name)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									openChannel(channel.id, channel.name);
								}
							}}
							role="button"
							tabIndex={0}
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={Tv01Icon}
							/>
							<OverflowTooltip
								className="min-w-0 flex-1 truncate text-sm"
								text={channel.name}
							/>
							<span className="shrink-0 text-muted-foreground/70 text-xs">
								{CHANNEL_LABELS[channel.channelType]}
							</span>
							{channel.agentId &&
							!agents.some((agent) => agent.id === channel.agentId) ? (
								<span
									aria-label="This channel was reverted to the default agent"
									className="font-semibold text-amber-600 text-xs dark:text-amber-400"
									title="This channel was reverted to the default agent because its original agent was deleted"
								>
									!
								</span>
							) : null}
							{/* A dim dot marks a disabled bot; enabled bots show none. */}
							{!channel.enabled && (
								<span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
							)}
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem
							onClick={() => openChannel(channel.id, channel.name, true)}
						>
							<HugeiconsIcon
								className="mr-2 size-4"
								icon={ArrowUpRight01Icon}
							/>
							Open in new tab
						</ContextMenuItem>
						<OpenInNewWindowContextMenuItem
							onClick={() =>
								void openEntityInNewWindow({
									path: `/channels/${channel.id}`,
									title: channel.name,
								})
							}
						/>
					</ContextMenuContent>
				</ContextMenu>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton
					onClick={() => setAddDialogOpen(true)}
					title="Add channel"
				/>
			}
			collapsed={collapsed}
			dnd={dnd}
			label="Channels"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="channels"
			sort={sort}
		>
			{channels.length === 0 ? (
				<p className="px-2 py-2 text-muted-foreground text-xs">
					{emptyMessage}
				</p>
			) : (
				<>
					<SidebarMenu className="gap-0.5">
						{renderChannelRows(paged.visible)}
					</SidebarMenu>
					<SectionPagingControls
						overflow={{
							getSearchText: (channel) => channel.name ?? "",
							items: paged.items,
							label: "channels",
							renderList: (list) => (
								<SidebarMenu className="gap-0.5">
									{renderChannelRows(list)}
								</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</>
			)}
			<AddChannelDialog
				agents={agents.map((a) => ({ id: a.id, name: a.name }))}
				initialAgentId={channelSetupRequest?.agentId}
				initialAgentName={channelSetupRequest?.agentName}
				initialChannelType={channelSetupRequest?.channelType}
				onCreate={async (input) => {
					try {
						await create(input);
						toast.success({ title: `Channel "${input.name}" created` });
						return true;
					} catch (e) {
						toast.error({
							title:
								e instanceof Error ? e.message : "Could not create channel",
						});
						return false;
					}
				}}
				onNodeCreated={async (name) => {
					// The managed-bot path has the NODE write the config, so `create`
					// never ran and this list still shows the old set.
					await refresh();
					toast.success({ title: `Channel "${name}" created` });
				}}
				onOpenChange={setAddDialogOpen}
				open={addDialogOpen}
				teams={teams.map((t) => ({ id: t.id, name: t.name }))}
			/>
		</SidebarSection>
	);
}

/** A single Composio integration row's glyph: the toolkit's remote logo, or a
 *  fallback icon when it has none. */
function IntegrationLogo({
	logo,
	name,
}: {
	logo: string | null | undefined;
	name: string;
}) {
	if (!logo) {
		return (
			<HugeiconsIcon
				className="size-4 shrink-0 text-muted-foreground"
				icon={ConnectIcon}
			/>
		);
	}
	return (
		// biome-ignore lint/performance/noImgElement: Tauri/Vite app, no next/image; logo is a remote Composio URL
		// biome-ignore lint/correctness/useImageSize: sized via the `size-4` class, dimensions are fixed
		<img
			alt={`${name} logo`}
			className="size-4 shrink-0 rounded-sm bg-background object-contain"
			draggable={false}
			src={logo}
		/>
	);
}

/** Integrations list in the sidebar — the user's connected Composio accounts
 *  (Gmail, GitHub, Slack, …), each with its toolkit logo. Rows and the "+" open
 *  App Settings → Integrations. Hidden by default (opt-in feature). */
function IntegrationsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	// Integrations moved into the Gateway dialog (a keys/BYOK + registry surface),
	// so the section's "manage" affordance opens Gateway → Integrations.
	const openGateway = useGatewayDialog((s) => s.openGateway);
	// Only query connections once a Composio key is configured on the node.
	// Without a key, /connections returns an error — treat that as "not set up
	// yet" (an actionable empty state) rather than a load failure that a Retry
	// can never fix.
	const statusQuery = useComposioStatus();
	const configured = statusQuery.data?.configured ?? false;
	const connectionsQuery = useComposioConnections("", configured);
	const connections = useMemo(
		() => connectionsQuery.data ?? [],
		[connectionsQuery.data]
	);
	// Only fetch the (large) toolkit catalog once there are connections to label.
	const toolkitsQuery = useComposioToolkits(connections.length > 0);
	const toolkitBySlug = useMemo(
		() => new Map((toolkitsQuery.data ?? []).map((t) => [t.slug, t])),
		[toolkitsQuery.data]
	);

	// Enrich each connection with its toolkit's display name + logo so the shared
	// name-sorter can order them and rows can render a logo.
	const rows = useMemo(
		() =>
			connections.map((conn) => {
				const toolkit = toolkitBySlug.get(conn.toolkit);
				return {
					id: conn.id,
					name: toolkit?.name ?? conn.toolkit,
					logo: toolkit?.logo ?? null,
					active: conn.active,
				};
			}),
		[connections, toolkitBySlug]
	);
	const paged = usePaged(sortItems(rows, sort, NAMED_SORT_ACCESSORS), pageSize);

	const openIntegrations = () => openGateway("integrations");

	const isLoading = statusQuery.isLoading || connectionsQuery.isLoading;
	let emptyMessage: string;
	if (isLoading) {
		emptyMessage = "Loading…";
	} else if (configured) {
		emptyMessage = "No integrations connected";
	} else {
		emptyMessage = "No integrations set up yet";
	}

	const renderIntegrationRows = (list: typeof rows) =>
		list.map((row) => (
			<SidebarMenuItem key={row.id}>
				{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
				<div
					className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
					onClick={openIntegrations}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							openIntegrations();
						}
					}}
					role="button"
					tabIndex={0}
				>
					<IntegrationLogo logo={row.logo} name={row.name} />
					<OverflowTooltip
						className="min-w-0 flex-1 truncate text-sm"
						text={row.name}
					/>
					{/* A dim dot marks an inactive connection; active shows none. */}
					{!row.active && (
						<span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
					)}
				</div>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton onClick={openIntegrations} title="Add integration" />
			}
			collapsed={collapsed}
			dnd={dnd}
			label="Integrations"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="integrations"
			sort={sort}
		>
			{configured && connectionsQuery.isError && connections.length === 0 && (
				<SectionLoadError
					message="Couldn't load your integrations."
					onRetry={() => {
						connectionsQuery.refetch().catch(() => undefined);
					}}
				/>
			)}
			{!(configured && connectionsQuery.isError) &&
				connections.length === 0 && (
					<p className="px-2 py-2 text-muted-foreground text-xs">
						{emptyMessage}
					</p>
				)}
			{connections.length > 0 && (
				<>
					<SidebarMenu className="gap-0.5">
						{renderIntegrationRows(paged.visible)}
					</SidebarMenu>
					<SectionPagingControls
						overflow={{
							getSearchText: (row) => row.name ?? "",
							items: paged.items,
							label: "integrations",
							renderList: (list) => (
								<SidebarMenu className="gap-0.5">
									{renderIntegrationRows(list)}
								</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</>
			)}
		</SidebarSection>
	);
}

/** Identities list in the sidebar — saved login profiles agents reuse. Each row
 *  is a profile (a named grouping of per-domain connections). Rows open the
 *  identities manage page focused on that profile; "+" opens create. Hidden by
 *  default. This is the picker; the manage tab is create/edit only. */
function IdentitiesSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const { profiles, loading, error, refetch, create } = useIdentities();
	const { openTab } = useTabsContext();
	const [addDialogOpen, setAddDialogOpen] = useState(false);
	const rows = useMemo(
		() =>
			profiles.map((profile) => ({
				id: profile.profile_id,
				name: profile.profile_id,
				count: profile.connections.length,
			})),
		[profiles]
	);
	const paged = usePaged(sortItems(rows, sort, NAMED_SORT_ACCESSORS), pageSize);

	const openIdentity = (profileId: string, forceNew = false) =>
		openTab(`/identities/profile/${encodeURIComponent(profileId)}`, {
			title: profileId,
			forceNew,
		});

	const emptyMessage = loading ? "Loading…" : "No identities yet";

	const renderIdentityRows = (list: typeof rows) =>
		list.map((row) => (
			<SidebarMenuItem key={row.id}>
				<ContextMenu>
					<ContextMenuTrigger>
						{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
						<div
							className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									openIdentity(row.id, true);
								}
							}}
							onClick={() => openIdentity(row.id)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									openIdentity(row.id);
								}
							}}
							role="button"
							tabIndex={0}
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={FingerPrintIcon}
							/>
							<OverflowTooltip
								className="min-w-0 flex-1 truncate text-sm"
								text={row.name}
							/>
							<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
								{formatCount(row.count) ?? "—"}
							</span>
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem onClick={() => openIdentity(row.id, true)}>
							<HugeiconsIcon
								className="mr-2 size-4"
								icon={ArrowUpRight01Icon}
							/>
							Open in new tab
						</ContextMenuItem>
						<OpenInNewWindowContextMenuItem
							onClick={() =>
								void openEntityInNewWindow({
									path: `/identities/profile/${encodeURIComponent(row.id)}`,
									title: row.name,
								})
							}
						/>
					</ContextMenuContent>
				</ContextMenu>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton
					onClick={() => setAddDialogOpen(true)}
					title="Add identity"
				/>
			}
			collapsed={collapsed}
			dnd={dnd}
			label="Identities"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="identities"
			sort={sort}
		>
			{error && profiles.length === 0 && (
				<SectionLoadError
					message="Couldn't load your identities."
					onRetry={refetch}
				/>
			)}
			{!error && profiles.length === 0 && (
				<p className="px-2 py-2 text-muted-foreground text-xs">
					{emptyMessage}
				</p>
			)}
			{profiles.length > 0 && (
				<>
					<SidebarMenu className="gap-0.5">
						{renderIdentityRows(paged.visible)}
					</SidebarMenu>
					<SectionPagingControls
						overflow={{
							getSearchText: (row) => row.name ?? "",
							items: paged.items,
							label: "identities",
							renderList: (list) => (
								<SidebarMenu className="gap-0.5">
									{renderIdentityRows(list)}
								</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</>
			)}
			<AddIdentityDialog
				existingProfileIds={profiles.map((p) => p.profile_id)}
				onCreate={async (input) => {
					try {
						await create(input);
						toast.success({
							title: `Connection for ${input.domain} created`,
						});
					} catch (e) {
						toast.error({
							title:
								e instanceof Error ? e.message : "Could not create connection",
						});
					}
				}}
				onOpenChange={setAddDialogOpen}
				open={addDialogOpen}
			/>
		</SidebarSection>
	);
}

/** Skills list in the sidebar — the user's installed agent skills. Rows and the
 *  "+" open the Skills store page. Hidden by default (opt-in feature). Queries
 *  the installed set directly (not `useSkillsCatalog`, which also fetches the
 *  remote directory) so mounting the section stays cheap. */
function SkillsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const { openTab } = useTabsContext();
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token ?? null,
		userJwt: node.userJwt ?? null,
	};
	const skillsQuery = useQuery({
		queryKey: ["skills", "installed", target.url],
		queryFn: () => listSkills(target),
	});
	const skills = skillsQuery.data ?? [];
	const paged = usePaged(
		sortItems(skills, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const openSkills = (forceNew = false) =>
		openTab("/skills", { title: "Skills", forceNew });

	const emptyMessage = skillsQuery.isLoading
		? "Loading…"
		: "No skills installed";

	const renderSkillRows = (list: typeof skills) =>
		list.map((skill) => (
			<SidebarMenuItem key={skill.id}>
				<ContextMenu>
					<ContextMenuTrigger>
						{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
						<div
							className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									openSkills(true);
								}
							}}
							onClick={() => openSkills()}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									openSkills();
								}
							}}
							role="button"
							tabIndex={0}
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={PotionIcon}
							/>
							<OverflowTooltip
								className="min-w-0 flex-1 truncate text-sm"
								text={skill.name}
							/>
							{!skill.enabled && (
								<span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
							)}
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem onClick={() => openSkills(true)}>
							<HugeiconsIcon
								className="mr-2 size-4"
								icon={ArrowUpRight01Icon}
							/>
							Open in new tab
						</ContextMenuItem>
						<OpenInNewWindowContextMenuItem
							onClick={() =>
								void openEntityInNewWindow({ path: "/skills", title: "Skills" })
							}
						/>
					</ContextMenuContent>
				</ContextMenu>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton onClick={() => openSkills()} title="Add skill" />
			}
			collapsed={collapsed}
			dnd={dnd}
			label="Skills"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="skills"
			sort={sort}
		>
			{skillsQuery.isError && skills.length === 0 && (
				<SectionLoadError
					message="Couldn't load your skills."
					onRetry={() => {
						skillsQuery.refetch().catch(() => undefined);
					}}
				/>
			)}
			{!skillsQuery.isError && skills.length === 0 && (
				<p className="px-2 py-2 text-muted-foreground text-xs">
					{emptyMessage}
				</p>
			)}
			{skills.length > 0 && (
				<>
					<SidebarMenu className="gap-0.5">
						{renderSkillRows(paged.visible)}
					</SidebarMenu>
					<SectionPagingControls
						overflow={{
							getSearchText: (skill) => skill.name ?? "",
							items: paged.items,
							label: "skills",
							renderList: (list) => (
								<SidebarMenu className="gap-0.5">
									{renderSkillRows(list)}
								</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</>
			)}
		</SidebarSection>
	);
}

/** MCP servers list in the sidebar — the servers registered on this node. Rows
 *  and the "+" open the Tools page, where MCP servers are managed. Keyed by
 *  `name` (McpServer has no id). Hidden by default. */
function McpSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const { openTab } = useTabsContext();
	const { servers, loading, error, reload } = useMcp();
	const paged = usePaged(
		sortItems(servers, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const openTools = (forceNew = false) =>
		openTab("/tools", { title: "Tools", forceNew });
	const openToolsInNewWindow = () =>
		void openEntityInNewWindow({ path: "/tools", title: "Tools" });

	const emptyMessage = loading ? "Loading…" : "No MCP servers";

	const renderServerRows = (list: typeof servers) =>
		list.map((server) => (
			<SidebarMenuItem key={server.name}>
				<ContextMenu>
					<ContextMenuTrigger>
						{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
						<div
							className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									openTools(true);
								}
							}}
							onClick={() => openTools()}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									openTools();
								}
							}}
							role="button"
							tabIndex={0}
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={ServerStack01Icon}
							/>
							<OverflowTooltip
								className="min-w-0 flex-1 truncate text-sm"
								text={server.name}
							/>
							{!server.enabled && (
								<span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
							)}
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem onClick={() => openTools(true)}>
							<HugeiconsIcon
								className="mr-2 size-4"
								icon={ArrowUpRight01Icon}
							/>
							Open in new tab
						</ContextMenuItem>
						<OpenInNewWindowContextMenuItem onClick={openToolsInNewWindow} />
					</ContextMenuContent>
				</ContextMenu>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton onClick={() => openTools()} title="Add MCP server" />
			}
			collapsed={collapsed}
			dnd={dnd}
			label="MCP"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="mcp"
			sort={sort}
		>
			{error && servers.length === 0 && (
				<SectionLoadError
					message="Couldn't load your MCP servers."
					onRetry={() => {
						reload().catch(() => undefined);
					}}
				/>
			)}
			{!error && servers.length === 0 && (
				<p className="px-2 py-2 text-muted-foreground text-xs">
					{emptyMessage}
				</p>
			)}
			{servers.length > 0 && (
				<>
					<SidebarMenu className="gap-0.5">
						{renderServerRows(paged.visible)}
					</SidebarMenu>
					<SectionPagingControls
						overflow={{
							getSearchText: (server) => server.name ?? "",
							items: paged.items,
							label: "MCP servers",
							renderList: (list) => (
								<SidebarMenu className="gap-0.5">
									{renderServerRows(list)}
								</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</>
			)}
		</SidebarSection>
	);
}

/** Individual tools available across the installed MCP servers, listed like
 *  Skills/MCP. Rows and the "+" open the Tools page. Sourced from the same
 *  useMcp() feed as the MCP section, but lists the tools rather than servers. */
function ToolsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const { openTab } = useTabsContext();
	const { tools, loading, error, reload } = useMcp();
	const paged = usePaged(
		sortItems(tools, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const openTools = (forceNew = false) =>
		openTab("/tools", { title: "Tools", forceNew });

	const openToolsInNewWindow = () =>
		void openEntityInNewWindow({ path: "/tools", title: "Tools" });

	const emptyMessage = loading ? "Loading…" : "No tools";

	const renderToolRows = (list: typeof tools) =>
		list.map((tool) => (
			<SidebarMenuItem key={tool.id}>
				<ContextMenu>
					<ContextMenuTrigger>
						{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
						<div
							className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									openTools(true);
								}
							}}
							onClick={() => openTools()}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									openTools();
								}
							}}
							role="button"
							tabIndex={0}
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={Wrench01Icon}
							/>
							<OverflowTooltip
								className="min-w-0 flex-1 truncate text-sm"
								text={tool.name}
							/>
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem onClick={() => openTools(true)}>
							<HugeiconsIcon
								className="mr-2 size-4"
								icon={ArrowUpRight01Icon}
							/>
							Open in new tab
						</ContextMenuItem>
						<OpenInNewWindowContextMenuItem onClick={openToolsInNewWindow} />
					</ContextMenuContent>
				</ContextMenu>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton onClick={() => openTools()} title="Browse tools" />
			}
			collapsed={collapsed}
			dnd={dnd}
			label="Tools"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="tools"
			sort={sort}
		>
			{error && tools.length === 0 && (
				<SectionLoadError
					message="Couldn't load your tools."
					onRetry={() => {
						reload().catch(() => undefined);
					}}
				/>
			)}
			{!error && tools.length === 0 && (
				<p className="px-2 py-2 text-muted-foreground text-xs">
					{emptyMessage}
				</p>
			)}
			{tools.length > 0 && (
				<>
					<SidebarMenu className="gap-0.5">
						{renderToolRows(paged.visible)}
					</SidebarMenu>
					<SectionPagingControls
						overflow={{
							getSearchText: (tool) => tool.name ?? "",
							items: paged.items,
							label: "tools",
							renderList: (list) => (
								<SidebarMenu className="gap-0.5">
									{renderToolRows(list)}
								</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</>
			)}
		</SidebarSection>
	);
}

/** Plugins list in the sidebar — the user's installed apps/plugins. Rows and the
 *  "+" open the Plugins store page. Hidden by default. */
function PluginsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const { openTab } = useTabsContext();
	const { apps, loading, error, reload } = useApps();
	const installed = useMemo(() => apps.filter((a) => a.installed), [apps]);
	const paged = usePaged(
		sortItems(installed, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const openPlugins = (forceNew = false) =>
		openTab("/apps", { title: "Plugins", forceNew });

	const openPluginsInNewWindow = () =>
		void openEntityInNewWindow({ path: "/apps", title: "Plugins" });

	const emptyMessage = loading ? "Loading…" : "No plugins installed";

	const renderPluginRows = (list: typeof installed) =>
		list.map((app) => (
			<SidebarMenuItem key={app.id}>
				<ContextMenu>
					<ContextMenuTrigger>
						{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
						<div
							className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									openPlugins(true);
								}
							}}
							onClick={() => openPlugins()}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									openPlugins();
								}
							}}
							role="button"
							tabIndex={0}
						>
							{/* The app's real icon square, identical to the Store's — the
							    manifest icon over its dither/flat background, falling back to
							    the generative tile seeded by plugin id. Previously this took
							    only `companion.icon` and painted it flat, so an app whose
							    icon lives on the manifest (most of them) fell through to one
							    repeated puzzle glyph. `companion.icon` stays as the first
							    choice: a companion that registers its own icon is being
							    specific about this surface. */}
							<AppIcon
								cacheKey={iconCacheKey(
									app.id,
									app.installedVersion ?? app.version
								)}
								className="size-5 rounded-[5px]"
								dither={app.iconDither}
								iconBackground={app.iconBackground ?? undefined}
								iconId={app.companion?.icon ?? app.icon}
								iconPadding={app.iconPadding}
								iconUrl={app.iconUrl}
								name={app.name}
								seedId={app.id}
								size={12}
							/>
							<OverflowTooltip
								className="min-w-0 flex-1 truncate text-sm"
								text={app.name}
							/>
							{/* The SAME status glyphs the Store's catalog rows wear, so a
							    plugin reads identically wherever you meet it. This row used to
							    say "disabled" with a bare 1.5px grey dot: no tooltip, no
							    accessible name, and nothing at all for built-in — a mark you
							    could only learn by elimination. */}
							{app.builtIn ? <StatusBadge kind="builtin" /> : null}
							{app.enabled ? null : (
								<StatusBadge kind="unavailable" label="Disabled" />
							)}
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem onClick={() => openPlugins(true)}>
							<HugeiconsIcon
								className="mr-2 size-4"
								icon={ArrowUpRight01Icon}
							/>
							Open in new tab
						</ContextMenuItem>
						<OpenInNewWindowContextMenuItem onClick={openPluginsInNewWindow} />
					</ContextMenuContent>
				</ContextMenu>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton onClick={() => openPlugins()} title="Add plugin" />
			}
			collapsed={collapsed}
			dnd={dnd}
			label="Plugins"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="plugins"
			sort={sort}
		>
			{error && installed.length === 0 && (
				<SectionLoadError
					message="Couldn't load your plugins."
					onRetry={() => {
						reload().catch(() => undefined);
					}}
				/>
			)}
			{!error && installed.length === 0 && (
				<p className="px-2 py-2 text-muted-foreground text-xs">
					{emptyMessage}
				</p>
			)}
			{installed.length > 0 && (
				<>
					<SidebarMenu className="gap-0.5">
						{renderPluginRows(paged.visible)}
					</SidebarMenu>
					<SectionPagingControls
						overflow={{
							getSearchText: (app) => app.name ?? "",
							items: paged.items,
							label: "plugins",
							renderList: (list) => (
								<SidebarMenu className="gap-0.5">
									{renderPluginRows(list)}
								</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</>
			)}
		</SidebarSection>
	);
}

/** Apps shelf in the sidebar. First-party Apps get one visual tile each; their
 * internal views are not flattened into the host's top-button list. Plugins stay in
 * the Plugins section and never appear in this shelf. */
function AppsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const { openTab } = useTabsContext();
	const { companions, sidebar_buttons: sidebarButtons } =
		usePluginContributions();
	const report = useOptionalReport();
	const { apps } = useApps();
	const appItems = useMemo<PinnedAppItem[]>(() => {
		const companionByApp = new Map<string, (typeof companions)[number]>();
		for (const companion of companions) {
			if (
				companion.pluginId &&
				companion.hasUi !== false &&
				!companionByApp.has(companion.pluginId)
			) {
				companionByApp.set(companion.pluginId, companion);
			}
		}

		const entryByApp = new Map<string, { order: number; target: string }>();
		for (const button of [...sidebarButtons]
			.filter((candidate) => isRyuAppId(candidate.plugin))
			.sort(
				(a, b) =>
					(a.order ?? Number.MAX_SAFE_INTEGER) -
					(b.order ?? Number.MAX_SAFE_INTEGER)
			)) {
			if (!entryByApp.has(button.plugin)) {
				entryByApp.set(button.plugin, {
					order: button.order ?? Number.MAX_SAFE_INTEGER,
					target: button.target,
				});
			}
		}

		return apps
			.filter((app) => isRyuAppId(app.id) && app.installed && app.enabled)
			.sort(
				(a, b) =>
					(entryByApp.get(a.id)?.order ?? Number.MAX_SAFE_INTEGER) -
					(entryByApp.get(b.id)?.order ?? Number.MAX_SAFE_INTEGER)
			)
			.flatMap((app) => {
				const companion = companionByApp.get(app.id);
				const entry = entryByApp.get(app.id);
				const target = companion
					? pluginCompanionPath(companion.id)
					: entry?.target;
				if (!target) {
					return [];
				}
				return [
					{
						cacheKey: iconCacheKey(app.id, app.installedVersion ?? app.version),
						dither: app.iconDither,
						iconBackground: app.iconBackground,
						iconId: companion?.icon ?? app.companion?.icon ?? app.icon,
						iconPadding: app.iconPadding,
						iconUrl: app.iconUrl,
						id: app.id,
						label: app.name,
						seedId: app.id,
						target,
					},
				];
			});
	}, [apps, companions, sidebarButtons]);

	if (appItems.length === 0) {
		return null;
	}

	const handleOpen = (app: PinnedAppItem, newTab: boolean) => {
		openTab(app.target, { title: app.label, forceNew: newTab });
	};
	const handleOpenNewWindow = (app: PinnedAppItem) => {
		void openEntityInNewWindow({ path: app.target, title: app.label });
	};
	const handleReport = (app: PinnedAppItem) => {
		report?.open({
			id: app.id,
			kind: "plugin",
			itemName: app.label,
			source: "installed",
		});
	};

	return (
		<SidebarSection
			collapsed={collapsed}
			dnd={dnd}
			label="Apps"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="companions"
			sort={sort}
		>
			<PinnedAppStage
				apps={appItems}
				onOpen={handleOpen}
				onOpenNewWindow={handleOpenNewWindow}
				onReport={report ? handleReport : undefined}
			/>
		</SidebarSection>
	);
}

/**
 * An app-REGISTERED sidebar section, rendered generically from a `sidebar_sections`
 * contribution (the dynamic counterpart to the hardcoded Canvas/Whiteboard/Meetings
 * sections). Its live rows come from the contribution's declared `spec.source` — a
 * same-origin, safe Core-relative read path the shell fetches through the
 * authenticated node seam, mapped via {@link sourceItemsFromResponse} — so nothing
 * is hardcoded per app. Clicking a row
 * opens `spec.itemTarget` (a `{{item.<key>}}` route template) via `openTab`. Returns
 * null when empty *unless* the spec declares an `emptyState`, mirroring
 * {@link AppsSection}, so a disabled/empty app never leaves a phantom header while a
 * section whose emptiness is meaningful ("nothing is running") can still say so.
 *
 * The fetch is a react-query read keyed by (node, path, method): several sections
 * sourcing the SAME endpoint — the common case once one app slices one feed with
 * `source.filter` — share a single request and a single `source.refreshMs` poll,
 * which a per-section `fetch` loop could not. The poll is suspended while the
 * section is collapsed; a create/delete invalidates the key rather than re-fetching
 * one section's copy of shared data.
 *
 * Exported so the e2e harness can mount it in isolation (see
 * `e2e/harness/contributed-section-story.tsx`) — the two-line row is a visual
 * contract a type-check cannot verify.
 */
export function DynamicSidebarSection({
	contribution,
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps & { contribution: PluginSidebarSection }) {
	const { openTab } = useTabsContext();
	const node = useActiveNode();
	const queryClient = useQueryClient();
	const spec = contribution.spec;
	const canUseDeclarativeHttp = (contribution.approved_grants ?? []).includes(
		DECLARATIVE_HTTP_GRANT
	);
	const [pendingAction, setPendingAction] = useState<string | null>(null);
	const [pendingCreate, setPendingCreate] = useState(false);
	const entityRowsFor = useContributedRowsFor(
		spec?.entity?.anchor ?? "",
		spec?.entity?.idKey ?? "id"
	);
	const source = spec?.source;
	const sourceRequest = contributionSourceRequest(contribution, source);
	const sourcePath = source?.http?.path;
	const sourceMethod = source?.http?.method ?? "GET";
	const refreshMs = normalizeViewRefreshMs(source?.refreshMs);
	const fetchable = Boolean(
		canUseDeclarativeHttp &&
			sourceRequest &&
			source &&
			sourcePath &&
			isCoreReadPath(sourcePath) &&
			isViewSourceHttpMethod(sourceMethod)
	);
	const target = toTarget(node);
	// Shared across every section reading the same endpoint on the same node. The
	// PAYLOAD is cached, not the mapped rows, because two sections map/filter the
	// same payload differently.
	const queryKey = useMemo(
		() => [
			"contributed-section-source",
			target.url,
			target.token,
			sourceRequest?.path ?? "",
			sourceRequest?.method ?? "",
		],
		[target.url, target.token, sourceRequest]
	);

	const { data: payload } = useQuery({
		queryKey,
		enabled: fetchable,
		// A dead node or a route gated behind a disabled app answers non-2xx; that
		// is an empty section, not an error state to retry into.
		retry: false,
		queryFn: async () => {
			if (!sourceRequest) {
				return null;
			}
			const resp = await fetch(apiUrl(target, sourceRequest.path), {
				method: sourceRequest.method,
				headers: await requestHeaders(target),
			});
			return resp.ok ? ((await resp.json()) as unknown) : null;
		},
		// Live sections declare their own cadence; the floor keeps a typo like
		// `refreshMs: 10` from turning the sidebar into a request loop. Collapsed =
		// nothing visible to keep fresh, so the poll stops.
		refetchInterval: refreshMs !== null && !collapsed ? refreshMs : false,
	});

	const rows = useMemo(
		() => (source && payload ? sourceItemsFromResponse(source, payload) : []),
		[source, payload]
	);

	const reload = useCallback(
		() => queryClient.invalidateQueries({ queryKey }),
		[queryClient, queryKey]
	);

	// An app-registered section honours "Group lists by date" like the shell's own
	// lists do — the whole point of the preference being a sidebar primitive rather
	// than a property of the Chats section. The stamp comes from the spec's declared
	// `dateKey` when it has one, else from probing the stamp names Core already
	// serves, so a section authored before this existed groups without a manifest
	// edit. A row that resolves nothing lands in "Undated", never back-dated.
	const [groupByDate] = useChatDateGrouping();
	const contributedStamp = useCallback(
		(row: SourceItem) => rowStamp(row.raw, spec?.dateKey),
		[spec?.dateKey]
	);
	const contributedBucketKeys = dateBucketStorageKeys(
		`contributed:${contribution.plugin}:${contribution.id}`
	);

	const openTarget = (
		item: Record<string, unknown>,
		title: string,
		forceNew = false
	) => {
		if (spec?.itemTarget) {
			// A contributed target may carry allowlisted query parameters that belong
			// in openTab's OPTIONS (a conversation id has no route of its own).
			const { path, options } = parseContributedTarget(
				renderTemplate(spec.itemTarget, { item }, { uriEncode: true })
			);
			const mountContext = spec.context
				? Object.fromEntries(
						Object.entries(spec.context).flatMap(([contextKey, rowKey]) => {
							const value = item[rowKey];
							return value === undefined || value === null
								? []
								: [[contextKey, value]];
						})
					)
				: undefined;
			openTab(path, {
				...options,
				...(spec.context ? { mountContext: mountContext ?? null } : {}),
				title,
				forceNew,
				icon: asGlyphValue(item.icon),
			});
		}
	};

	const openTargetInNewWindow = (
		item: Record<string, unknown>,
		title: string
	) => {
		if (!spec?.itemTarget) {
			return;
		}
		const { path, options } = parseContributedTarget(
			renderTemplate(spec.itemTarget, { item }, { uriEncode: true })
		);
		void openEntityInNewWindow({
			conversationId: options.conversationId,
			path,
			title,
		});
	};

	// Run a per-row `http` action (delete/…) templated with the row, then re-fetch.
	const runAction = async (
		http: ViewActionHttp,
		item: Record<string, unknown>
	) => {
		if (!canUseDeclarativeHttp) {
			return;
		}
		const actionKey = `${http.method}:${http.path}:${String(item.id ?? "")}`;
		if (pendingAction === actionKey) {
			return;
		}
		setPendingAction(actionKey);
		try {
			const target = toTarget(node);
			const rendered = renderContributionActionHttp(contribution, http, {
				item,
			});
			const resp = await fetch(apiUrl(target, rendered.path), {
				method: rendered.method,
				headers: await requestHeaders(target),
				body:
					rendered.body === undefined
						? undefined
						: JSON.stringify(rendered.body),
			});
			if (resp.ok) {
				await reload();
			}
		} catch {
			// best-effort
		} finally {
			setPendingAction((current) => (current === actionKey ? null : current));
		}
	};

	// The "+" create-and-open: POST the create request, read the new id from the
	// response (`targetFrom`) and open it via `itemTarget`; else just re-fetch.
	const runCreate = async () => {
		if (!spec?.create) {
			return;
		}
		if ("target" in spec.create && typeof spec.create.target === "string") {
			const { path, options } = parseContributedTarget(spec.create.target);
			openTab(path, {
				...options,
				title: spec.create.label ?? `New ${contribution.title}`,
			});
			return;
		}
		if (!canUseDeclarativeHttp) {
			return;
		}
		if (pendingCreate) {
			return;
		}
		setPendingCreate(true);
		try {
			const target = toTarget(node);
			const rendered = renderContributionActionHttp(
				contribution,
				spec.create.http,
				{}
			);
			const resp = await fetch(apiUrl(target, rendered.path), {
				method: rendered.method,
				headers: await requestHeaders(target),
				body:
					rendered.body === undefined
						? undefined
						: JSON.stringify(rendered.body),
			});
			if (!resp.ok) {
				return;
			}
			const created = (await resp.json()) as Record<string, unknown>;
			const newId = spec.create.targetFrom
				? created[spec.create.targetFrom]
				: undefined;
			if (spec.itemTarget && newId !== undefined) {
				openTarget(
					created,
					String(created.title ?? created.name ?? "Untitled")
				);
			} else {
				await reload();
			}
		} catch {
			// best-effort
		} finally {
			setPendingCreate(false);
		}
	};

	// A section with nothing to list, no way to create AND nothing to say when empty
	// renders nothing (mirrors AppsSection) — no phantom header for a disabled/empty
	// app. An `emptyState` is the opt-in that keeps the header, for a section whose
	// emptiness is itself the answer.
	const canCreate = Boolean(
		spec?.create && ("target" in spec.create || canUseDeclarativeHttp)
	);
	if (rows.length === 0 && !(canCreate || spec?.emptyState)) {
		return null;
	}

	const sectionKey: SectionKey = `plugin:${contribution.plugin}:${contribution.id}`;
	const itemActions = canUseDeclarativeHttp ? (spec?.itemActions ?? []) : [];

	// "messaging" draws the avatar-led two-line row the shell's own Agents section
	// draws (see MessagingAgentRowBody): a 36px round avatar, the title and a stamp
	// on the first line, a preview below. A section that declares it keeps that
	// shape for every row, including rows whose feed resolved no picture — a list
	// whose height changed row by row would scan as two lists.
	const messagingRows = spec?.rowStyle === "messaging";

	// One row of the contributed feed, extracted so the flat list and each date
	// bucket render the IDENTICAL row rather than a copy that drifts.
	const renderContributedRows = (list: SourceItem[]) => (
		<SidebarMenu className="gap-0.5">
			{list.map((row) => {
				const title = row.item.title;
				// A row with supporting text (its project, say) is a TALLER two-line
				// row; one without keeps the single-line height, so a section that
				// mixes both still scans as one list.
				const subtitle = row.item.subtitle;
				const open = (forceNew = false) => openTarget(row.raw, title, forceNew);
				const entityRows = spec?.entity ? entityRowsFor(row.item.id) : [];
				return (
					<SidebarMenuItem key={row.item.id}>
						<ContextMenu>
							<ContextMenuTrigger>
								{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
								<div
									className={
										messagingRows
											? "group/row flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted"
											: `group/row flex cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted ${
													subtitle ? "h-11" : "h-8"
												}`
									}
									onAuxClick={(e) => {
										if (e.button === 1) {
											e.preventDefault();
											open(true);
										}
									}}
									onClick={() => open()}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											open();
										}
									}}
									role="button"
									tabIndex={0}
								>
									{(() => {
										// `row.item.icon` is the MAPPED glyph, which defaults to the
										// raw row's `icon` key — the field this read directly before
										// the map could name it. Unmapped feeds are unaffected.
										const glyph = asGlyphValue(row.item.icon) ?? null;
										const sectionGlyph = contribution.icon ? (
											<Icon
												className={
													messagingRows
														? "size-4 text-muted-foreground"
														: "size-4 shrink-0 text-muted-foreground"
												}
												icon={contribution.icon}
												size={16}
											/>
										) : null;
										if (!messagingRows) {
											return (
												<GlyphDisplay
													className="size-4 shrink-0 text-muted-foreground"
													fallback={sectionGlyph}
													size={16}
													value={glyph}
												/>
											);
										}
										// The avatar-led lead: the row's own picture when the feed
										// has one, else the same glyph in the circle the picture
										// would have filled, so the column stays aligned.
										return row.item.avatar ? (
											<img
												alt=""
												className="size-9 shrink-0 rounded-full bg-muted object-cover"
												src={row.item.avatar}
											/>
										) : (
											<span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
												<GlyphDisplay
													className="size-4 text-muted-foreground"
													fallback={sectionGlyph}
													size={16}
													value={glyph}
												/>
											</span>
										);
									})()}
									<SidebarItemPreview
										content={
											<SidebarPreviewTitle
												title={
													spec?.itemPreview?.title
														? renderTemplate(
																spec.itemPreview.title,
																{ item: row.raw },
																{}
															)
														: title
												}
											>
												{spec?.itemPreview?.description ? (
													<p className="line-clamp-4 text-muted-foreground text-xs leading-relaxed">
														{renderTemplate(
															spec.itemPreview.description,
															{ item: row.raw },
															{}
														)}
													</p>
												) : null}
												{spec?.itemPreview?.meta?.map((meta) => (
													<SidebarPreviewMeta
														key={meta.label}
														label={meta.label}
														value={renderTemplate(
															meta.value,
															{ item: row.raw },
															{}
														)}
													/>
												))}
											</SidebarPreviewTitle>
										}
									>
										<span className="flex min-w-0 flex-1 flex-col justify-center overflow-hidden">
											{messagingRows ? (
												<span className="flex min-w-0 items-center gap-2">
													<span className="min-w-0 flex-1 truncate text-sm leading-tight">
														{title}
													</span>
													{/* The mapped `accessory` is the stamp on this shape —
													    the same slot the shell's agent row gives the time
													    of the last message. */}
													{row.item.accessory ? (
														<span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
															{row.item.accessory}
														</span>
													) : null}
												</span>
											) : (
												<span className="truncate text-sm leading-tight">
													{title}
												</span>
											)}
											{subtitle || messagingRows ? (
												// A messaging row always draws its second line, muted
												// when the feed had nothing to preview, so the list keeps
												// one height.
												<span
													className={`truncate text-xs leading-tight ${
														subtitle
															? "text-muted-foreground"
															: "text-muted-foreground/60 italic"
													}`}
												>
													{subtitle ?? "No messages yet"}
												</span>
											) : null}
										</span>
									</SidebarItemPreview>
								</div>
							</ContextMenuTrigger>
							<ContextMenuContent>
								{spec?.itemTarget ? (
									<>
										<ContextMenuItem onClick={() => open(true)}>
											<HugeiconsIcon
												className="mr-2 size-4"
												icon={ArrowUpRight01Icon}
											/>
											Open in new tab
										</ContextMenuItem>
										<OpenInNewWindowContextMenuItem
											onClick={() => openTargetInNewWindow(row.raw, title)}
										/>
									</>
								) : null}
								{itemActions.map((action) =>
									action.http ? (
										<ContextMenuItem
											key={action.id}
											onClick={() => {
												if (action.http) {
													void runAction(action.http, row.raw);
												}
											}}
											variant={
												action.style === "danger" ? "destructive" : undefined
											}
										>
											{action.icon ? (
												<Icon
													className="mr-2 size-4"
													icon={action.icon}
													size={16}
												/>
											) : null}
											{action.label}
										</ContextMenuItem>
									) : null
								)}
								{entityRows.map((entityRow) => (
									<ContextMenuItem
										key={entityRow.id}
										onClick={entityRow.onSelect}
									>
										<span className="mr-2 inline-flex">
											<EntityRowGlyph row={entityRow} />
										</span>
										{entityRow.label}
									</ContextMenuItem>
								))}
							</ContextMenuContent>
						</ContextMenu>
					</SidebarMenuItem>
				);
			})}
		</SidebarMenu>
	);

	return (
		<SidebarSection
			action={
				canCreate && spec?.create ? (
					<SectionAddButton
						onClick={runCreate}
						title={spec.create.label ?? `New ${contribution.title}`}
					/>
				) : undefined
			}
			collapsed={collapsed}
			dnd={dnd}
			iconNode={
				contribution.icon ? (
					<Icon
						className="size-3.5 shrink-0 text-muted-foreground"
						icon={contribution.icon}
						size={14}
					/>
				) : (
					<HugeiconsIcon
						className="size-3.5 shrink-0 text-muted-foreground"
						icon={Package01Icon}
					/>
				)
			}
			label={contribution.title}
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey={sectionKey}
			sort={sort}
		>
			{rows.length === 0 && spec?.emptyState ? (
				<div className="px-2 py-2">
					<p className="text-muted-foreground text-xs">
						{/* `null` is the queryFn's marker for a non-2xx answer (a route
							    gated behind a disabled app, a node that is down) — reporting
							    that as "nothing here" states something the shell never
							    learned. `undefined` is merely the in-flight first load. */}
						{payload === null && spec.emptyState.unavailable
							? spec.emptyState.unavailable
							: spec.emptyState.title}
					</p>
					{spec.emptyState.description && payload !== null ? (
						<p className="mt-0.5 text-muted-foreground/70 text-xs">
							{spec.emptyState.description}
						</p>
					) : null}
				</div>
			) : null}
			{groupByDate ? (
				<DateGroupedRows
					className="ml-2 space-y-0.5"
					collapsedKey={contributedBucketKeys.collapsedKey}
					items={rows}
					orderKey={contributedBucketKeys.orderKey}
					renderRows={renderContributedRows}
					stampOf={contributedStamp}
				/>
			) : (
				renderContributedRows(rows)
			)}
		</SidebarSection>
	);
}

/**
 * The run-alongside catalog categories this section lists beside the swappable
 * Chat runtimes. `provider` is deliberately absent: that is the mutually
 * exclusive chat slot and it arrives via `useEngines`, which filters to it.
 *
 * Same pair as the Engines page's own `RUN_ALONGSIDE_CATEGORIES`
 * (`store/EnginesCatalogSection.tsx`), and for the same reason — every row here
 * opens that page, so the two must list the same engines.
 */
const SIDEBAR_RUN_ALONGSIDE_CATEGORIES = ["media", "voice"] as const;

const ENGINE_SHELF_ORDER_KEY = "ryu:sidebar-engine-shelf-order";
const ENGINE_SHELF_COLLAPSED_KEY = "ryu:sidebar-engine-shelf-collapsed";

/**
 * The shelves this section groups its rows into, in display order — the Engines
 * page's own groups, by the page's own labels, because every row here opens that
 * page. `shelf` matches the catalog category for the run-alongside kinds; `text`
 * is the chat-provider slot, which the page also calls "Text and Embedding".
 *
 * That label is the destination page's heading, NOT a promise that an embedding
 * engine can appear under it — none can. No embedding engine is a catalog entry
 * (Core's registry is test-locked at `embedding.len() == 0`), and the two
 * llama.cpp-derived retrieval engines the node dropdown does show come off
 * `/api/sidecar/status`, not the catalog, so this section — which is catalog-fed
 * and whose rows all open the Engines page — has nothing to put there. Renaming
 * it to "Text" would only make the sidebar and the page it opens disagree.
 */
const ENGINE_SHELVES: { icon: IconSvgElement; key: string; label: string }[] = [
	{ key: "text", label: "Text and Embedding", icon: LayerIcon },
	{ key: "media", label: "Image", icon: Image01Icon },
	{ key: "voice", label: "Speech", icon: Mic01Icon },
];

/** One engine row in the sidebar, flattened out of whichever hook produced it. */
interface SidebarEngineRow {
	displayName: string;
	/** Resident (chat) or running (image/speech) — both mean "live" to a reader. */
	live: boolean;
	name: string;
	/** Which {@link ENGINE_SHELVES} entry this row belongs under. */
	shelf: string;
}

/**
 * Engines list in the sidebar — every chat, image and speech engine installed on
 * this node. Rows and the "+" open the Engines store page; the resident chat
 * engine and any running speech/image sidecar show a live dot. Hidden by
 * default.
 *
 * Not "every runtime": the embeddings server and the reranker are not catalog
 * entries (see {@link ENGINE_SHELVES}), so they cannot be listed here, and the
 * Engines page these rows open does not list them either.
 *
 * TWO data sources, not one. `useEngines` is the Engines *page*'s chat-slot hook
 * and filters the catalog to `category === "provider"`, so on a normal install it
 * yields llama.cpp and nothing else — which is why this section used to read as a
 * pointless one-row list no matter how much was installed. The rest of what the
 * node dropdown calls an engine (Whisper, Kokoro, an image model) lives in the
 * catalog's `voice` and `media` categories, which `useVoiceEngines` serves with a
 * real per-sidecar `running` flag.
 *
 * The fix is a second source rather than a wider filter: `useEngines().engines`
 * also backs `store/EnginesCatalogSection.tsx` and `pages/PreflightPage.tsx`,
 * where "engine" genuinely means the swappable chat runtime, and widening it
 * there would put a TTS voice in the Chat picker.
 *
 * Shelved rather than listed flat once more than one kind is installed, and
 * paged BEFORE it is shelved — the shape the Chats/Spaces date buckets already
 * use (`DateGroupedRows` takes `paged.visible`, and one `SectionPagingControls`
 * sits outside it). Paging each shelf on its own would let three shelves render
 * 3 × `pageSize` rows in a section whose page size exists to keep it short.
 * A single surviving shelf renders with no header at all: a lone "Text and
 * Embedding" divider inside a section already titled "Engines" is a nesting
 * level that names nothing new.
 */
function EnginesSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const { openTab } = useTabsContext();
	const { engines, loading, error, reload } = useEngines();
	const {
		engines: runAlongside,
		error: runAlongsideError,
		loading: runAlongsideLoading,
		reload: reloadRunAlongside,
	} = useVoiceEngines(SIDEBAR_RUN_ALONGSIDE_CATEGORIES);

	// Both hooks return catalog+state merged, so keep only what is actually
	// installed (plus the resident engine, which is installed by definition).
	const rows = useMemo<SidebarEngineRow[]>(
		() => [
			...engines
				.filter((e) => e.active || e.installState === "installed")
				.map((e) => ({
					name: e.name,
					displayName: e.displayName,
					live: e.active,
					shelf: "text",
				})),
			...runAlongside
				.filter((e) => e.installState === "installed")
				.map((e) => ({
					name: e.name,
					displayName: e.displayName,
					live: e.running,
					shelf: e.category,
				})),
		],
		[engines, runAlongside]
	);

	const paged = usePaged(
		sortItems(rows, sort, {
			created: () => null,
			name: (r) => r.displayName,
			updated: () => null,
		}),
		pageSize
	);

	// Shelves are derived from the VISIBLE slice, so "Show 3 more" can reveal a
	// whole new shelf — same as a date bucket appearing on page two.
	//
	// `count` is deliberately taken from ALL rows, not the page. Unlike the date
	// buckets this shape borrows from, the sort key (displayName) is orthogonal to
	// the shelf, so one page boundary cuts through every shelf at once — a
	// page-local count would tell someone with 3 speech engines installed that
	// they have 2. Headers therefore report what is installed and the rows under
	// them are the page; "Show N more" fills them in.
	const shelves = useMemo(
		() =>
			ENGINE_SHELVES.map((shelf) => ({
				...shelf,
				count: rows.filter((r) => r.shelf === shelf.key).length,
				rows: paged.visible.filter((r) => r.shelf === shelf.key),
			})).filter((shelf) => shelf.rows.length > 0),
		[paged.visible, rows]
	);
	const shelfKeys = useMemo(() => shelves.map((s) => s.key), [shelves]);
	// Default EXPANDED: the point of this change is that these engines were
	// invisible, so shipping them behind a closed shelf lands in the same place.
	const nested = useNestedSections(
		ENGINE_SHELF_ORDER_KEY,
		ENGINE_SHELF_COLLAPSED_KEY,
		shelfKeys,
		false
	);

	const openEngines = (forceNew = false) =>
		openTab("/engines", { title: "Engines", forceNew });

	const openEnginesInNewWindow = () =>
		void openEntityInNewWindow({ path: "/engines", title: "Engines" });

	const failed = error !== null || runAlongsideError !== null;
	const emptyMessage =
		loading || runAlongsideLoading ? "Loading…" : "No engines installed";

	const iconOf = (shelfKey: string) =>
		ENGINE_SHELVES.find((s) => s.key === shelfKey)?.icon ?? LayerIcon;

	const renderEngineRows = (list: SidebarEngineRow[]) =>
		list.map((engine) => (
			<SidebarMenuItem key={engine.name}>
				<ContextMenu>
					<ContextMenuTrigger>
						{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
						<div
							className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									openEngines(true);
								}
							}}
							onClick={() => openEngines()}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									openEngines();
								}
							}}
							role="button"
							tabIndex={0}
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={iconOf(engine.shelf)}
							/>
							<OverflowTooltip
								className="min-w-0 flex-1 truncate text-sm"
								text={engine.displayName}
							/>
							{/* Resident Chat, or a running speech/image sidecar. */}
							{engine.live && (
								<span className="size-1.5 shrink-0 rounded-full bg-primary" />
							)}
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem onClick={() => openEngines(true)}>
							<HugeiconsIcon
								className="mr-2 size-4"
								icon={ArrowUpRight01Icon}
							/>
							Open in new tab
						</ContextMenuItem>
						<OpenInNewWindowContextMenuItem onClick={openEnginesInNewWindow} />
					</ContextMenuContent>
				</ContextMenu>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton onClick={() => openEngines()} title="Add engine" />
			}
			collapsed={collapsed}
			dnd={dnd}
			label="Engines"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="engines"
			sort={sort}
		>
			{/* Gated on "nothing loaded", not on "something failed": one of the two
			    sources going down should still show what the other returned. */}
			{failed && rows.length === 0 && (
				<SectionLoadError
					message="Couldn't load your engines."
					onRetry={() => {
						reload().catch(() => undefined);
						reloadRunAlongside().catch(() => undefined);
					}}
				/>
			)}
			{!failed && rows.length === 0 && (
				<p className="px-2 py-2 text-muted-foreground text-xs">
					{emptyMessage}
				</p>
			)}
			{rows.length > 0 && (
				<>
					{shelves.length > 1 ? (
						nested.orderedKeys.map((key) => {
							const shelf = shelves.find((s) => s.key === key);
							if (!shelf) {
								return null;
							}
							return (
								<SubSection
									collapsed={nested.isCollapsed(key)}
									count={shelf.count}
									dnd={nested.dnd}
									icon={shelf.icon}
									key={key}
									label={shelf.label}
									onToggleCollapsed={nested.toggle}
									sectionKey={key}
								>
									<SidebarMenu className="gap-0.5">
										{renderEngineRows(shelf.rows)}
									</SidebarMenu>
								</SubSection>
							);
						})
					) : (
						<SidebarMenu className="gap-0.5">
							{renderEngineRows(paged.visible)}
						</SidebarMenu>
					)}
					<SectionPagingControls
						overflow={{
							getSearchText: (engine) => engine.displayName ?? "",
							items: paged.items,
							label: "engines",
							renderList: (list) => (
								<SidebarMenu className="gap-0.5">
									{renderEngineRows(list)}
								</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</>
			)}
		</SidebarSection>
	);
}

/** Pinned chats — floats above the chat history. Hidden when empty. */
function PinnedSection({
	collapsed,
	dnd,
	handlers,
	menu,
	onToggleCollapsed,
	pageSize,
	pinned,
	sort,
}: SectionProps & {
	handlers: ChatRowHandlers;
	pinned: Conversation[];
}) {
	const paged = usePaged(
		sortItems(pinned, sort, CONV_SORT_ACCESSORS),
		pageSize
	);
	if (pinned.length === 0) {
		return null;
	}
	return (
		<SidebarSection
			collapsed={collapsed}
			dnd={dnd}
			label="Pinned"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="pinned"
			sort={sort}
		>
			<SidebarChatList
				conversations={paged.visible}
				handlers={handlers}
				scope="pinned"
			/>
			<SectionPagingControls
				overflow={{
					getSearchText: (c) => c.title ?? "",
					items: paged.items,
					label: "pinned chats",
					renderList: (list) => (
						<ChatRowList conversations={list} handlers={handlers} />
					),
				}}
				paged={paged}
			/>
		</SidebarSection>
	);
}

/** Chat history — loose chats only (folder-scoped chats live nested under the
 *  single Projects section, rendered as ProjectsSection above this one). */
// ---------------------------------------------------------------------------
// Nested sub-sections (date buckets under Chats, folders under Projects)
//
// These reuse the exact section-header visual (chevron + grab-to-reorder + hover)
// but nest one level under a parent section, with their own per-child collapse
// and drag-order state. Two localStorage keys per surface: an order array and a
// "toggled" set (keys flipped away from the surface's default collapse state).
// ---------------------------------------------------------------------------

const CHAT_VISIBILITY_ORDER_KEY = "ryu:sidebar-chat-visibility-order";
const CHAT_VISIBILITY_COLLAPSED_KEY = "ryu:sidebar-collapsed-chat-visibility";
const PROJECT_ORDER_KEY = "ryu:sidebar-project-order";

/** Persisted ordering for a set of nested sub-sections (keys the user dragged). */
function loadOrder(key: string): string[] {
	try {
		const stored = localStorage.getItem(key);
		if (!stored) {
			return [];
		}
		const parsed = JSON.parse(stored);
		return Array.isArray(parsed)
			? parsed.filter((x): x is string => typeof x === "string")
			: [];
	} catch {
		return [];
	}
}

function saveOrder(key: string, order: string[]) {
	try {
		localStorage.setItem(key, JSON.stringify(order));
	} catch {
		// best-effort
	}
}

/** The date-bucketing primitive itself lives in `lib/sidebar/date-buckets.ts` —
 *  generic over the row type, so every list below can use it rather than only
 *  Chats. {@link DateGroupedRows} is the render half. */

/** Drag-and-drop wiring for the nested sub-sections (mirrors SectionDnd, but
 *  string-keyed and self-contained rather than threaded from the top level). */
interface SubSectionDnd {
	draggingKey: string | null;
	dragOverKey: string | null;
	onDragEnd: () => void;
	onDragOver: (key: string) => void;
	onDragStart: (key: string) => void;
	onDrop: (key: string) => void;
	order: string[];
}

interface VisibilitySubSectionDrop {
	accept: VisibilityResourceType;
	canDrop: (payload: VisibilityDragPayload) => boolean;
	canDropOnDragOver?: () => boolean;
	onDrop: (payload: VisibilityDragPayload) => void;
}

interface NestedSectionsState {
	dnd: SubSectionDnd;
	isCollapsed: (key: string) => boolean;
	orderedKeys: string[];
	toggle: (key: string) => void;
}

/** Owns per-child collapse + drag-order for one parent's sub-sections. The
 *  `toggled` set holds keys flipped away from `defaultCollapsed`, so the same
 *  storage serves a default-expanded surface (date buckets) and a
 *  default-collapsed one (projects). */
function useNestedSections(
	orderKey: string,
	collapseKey: string,
	keys: string[],
	defaultCollapsed: boolean
): NestedSectionsState {
	const [order, setOrder] = useState<string[]>(() => loadOrder(orderKey));
	const [toggled, setToggled] = useState<Set<string>>(() =>
		loadIdSet(collapseKey)
	);
	const [draggingKey, setDraggingKey] = useState<string | null>(null);
	const [dragOverKey, setDragOverKey] = useState<string | null>(null);

	// Keep the user's stored order for keys still present, append newcomers in
	// their natural (incoming) order, and drop keys that no longer exist.
	const orderedKeys = useMemo(() => {
		const present = new Set(keys);
		const known = order.filter((k) => present.has(k));
		const knownSet = new Set(known);
		const extras = keys.filter((k) => !knownSet.has(k));
		return [...known, ...extras];
	}, [order, keys]);

	const isCollapsed = (key: string) =>
		defaultCollapsed ? !toggled.has(key) : toggled.has(key);

	const toggle = (key: string) =>
		setToggled((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			saveIdSet(collapseKey, next);
			return next;
		});

	const reorder = (dragKey: string, dropKey: string) => {
		if (dragKey === dropKey) {
			return;
		}
		const base = [...orderedKeys];
		const from = base.indexOf(dragKey);
		const to = base.indexOf(dropKey);
		if (from < 0 || to < 0) {
			return;
		}
		base.splice(from, 1);
		const insertAt = base.indexOf(dropKey) + (from < to ? 1 : 0);
		base.splice(insertAt, 0, dragKey);
		setOrder(base);
		saveOrder(orderKey, base);
	};

	const clearDrag = () => {
		setDraggingKey(null);
		setDragOverKey(null);
	};

	return {
		dnd: {
			draggingKey,
			dragOverKey,
			onDragEnd: clearDrag,
			onDragOver: setDragOverKey,
			onDragStart: setDraggingKey,
			onDrop: (key) => {
				if (draggingKey) {
					reorder(draggingKey, key);
				}
				clearDrag();
			},
			order: orderedKeys,
		},
		isCollapsed,
		orderedKeys,
		toggle,
	};
}

/** A nested, collapsible, drag-reorderable sub-section that reuses the parent
 *  section header's look (chevron + grab cursor + hover). Indented under its
 *  parent for hierarchy. */
export function SubSection({
	action,
	children,
	collapsed,
	count,
	dnd,
	icon,
	iconNode,
	label,
	onToggleCollapsed,
	sectionKey,
	size = "sm",
	testId,
	visibilityDrop,
	wrapHeader,
}: {
	action?: ReactNode;
	children: ReactNode;
	collapsed: boolean;
	count?: number;
	dnd: SubSectionDnd;
	icon?: IconSvgElement;
	/** Custom glyph that replaces `icon` when provided (e.g. a project's emoji/logo). */
	iconNode?: ReactNode;
	label: string;
	onToggleCollapsed: (key: string) => void;
	sectionKey: string;
	testId?: string;
	/**
	 * `sm` (default) is the quiet date-bucket header inside Chats — a divider for
	 * rows that are themselves the content. `md` matches a ChatRow exactly (h-8,
	 * `text-sm`, 16px icon) and is for a sub-section that IS an entity in its own
	 * right, like a project folder: those sit beside Chats and Spaces in the same
	 * scan, so rendering them two steps smaller made them read as sub-labels of
	 * the section above rather than peers of it.
	 */
	size?: "sm" | "md";
	/** Optional resource visibility drop target for this group header/body. */
	visibilityDrop?: VisibilitySubSectionDrop;
	/** Optional wrapper for the header row — e.g. a right-click "Delete all
	 *  chats" context menu. Defaults to identity (no wrapper). */
	wrapHeader?: (header: ReactNode) => ReactNode;
}) {
	const isDragOver =
		dnd.dragOverKey === sectionKey &&
		dnd.draggingKey !== null &&
		dnd.draggingKey !== sectionKey;
	const isDragging = dnd.draggingKey === sectionKey;
	const dropBelow =
		isDragOver &&
		dnd.draggingKey !== null &&
		dnd.order.indexOf(dnd.draggingKey) < dnd.order.indexOf(sectionKey);
	const [visibilityDragOver, setVisibilityDragOver] = useState(false);
	const readVisibilityPayload = (event: ReactDragEvent<HTMLDivElement>) => {
		const customPayload = parseVisibilityDragPayload(
			event.dataTransfer.getData(RESOURCE_VISIBILITY_DND_MIME)
		);
		return (
			customPayload ??
			parseVisibilityDragPayload(event.dataTransfer.getData("text/plain"))
		);
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: sub-section is the drag-and-drop reorder target; the header button carries the keyboard-reachable affordance
		// biome-ignore lint/a11y/noNoninteractiveElementInteractions: sub-section is the drag-and-drop reorder target; the header button carries the keyboard-reachable affordance
		<div
			className={`group/subsection relative ${isDragging ? "opacity-50" : ""} ${visibilityDragOver ? "rounded-md bg-primary/5 ring-1 ring-primary/60" : ""}`}
			data-subsection-key={sectionKey}
			data-testid={testId}
			onDragLeave={(e) => {
				const relatedTarget = e.relatedTarget;
				if (
					!(
						relatedTarget instanceof Node &&
						e.currentTarget.contains(relatedTarget)
					)
				) {
					setVisibilityDragOver(false);
				}
			}}
			onDragOver={(e) => {
				const visibilityDrag =
					visibilityDrop &&
					e.dataTransfer.types.includes(
						resourceVisibilityDndMime(visibilityDrop.accept)
					);
				if (visibilityDrag) {
					const allowed = visibilityDrop.canDropOnDragOver?.() ?? true;
					setVisibilityDragOver(allowed);
					e.dataTransfer.dropEffect = allowed ? "move" : "none";
					if (allowed) {
						e.preventDefault();
						e.stopPropagation();
					}
					return;
				}
				setVisibilityDragOver(false);
				// Only intercept our own sub-section drags; let a top-level section
				// drag pass through to the parent group's handler.
				if (!dnd.draggingKey) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				e.dataTransfer.dropEffect = "move";
				dnd.onDragOver(sectionKey);
			}}
			onDrop={(e) => {
				const visibilityPayload = visibilityDrop
					? readVisibilityPayload(e)
					: null;
				if (
					visibilityDrop &&
					visibilityPayload?.resourceType === visibilityDrop.accept &&
					visibilityPayload.from !== sectionKey
				) {
					e.preventDefault();
					e.stopPropagation();
					setVisibilityDragOver(false);
					// Let the native dragend/pointer-release sequence finish before
					// opening a modal. Otherwise the release can be interpreted as an
					// outside interaction and immediately dismiss the confirmation.
					setTimeout(() => {
						if (visibilityDrop.canDrop(visibilityPayload)) {
							visibilityDrop.onDrop(visibilityPayload);
						}
					}, 0);
					return;
				}
				setVisibilityDragOver(false);
				if (!dnd.draggingKey) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				dnd.onDrop(sectionKey);
			}}
		>
			{isDragOver && (
				<div
					className={`reorder-drop-indicator pointer-events-none absolute inset-x-1 z-10 h-0.5 bg-primary ${dropBelow ? "bottom-0" : "top-0"}`}
				/>
			)}
			{visibilityDragOver && (
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 rounded-md border border-primary/50"
				/>
			)}
			{(() => {
				const headerRow = (
					<div className="relative flex items-center">
						<button
							className={`group/hdr flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-md px-2 text-foreground transition-colors active:cursor-grabbing ${
								size === "md" ? "h-8 text-sm hover:bg-muted" : "py-1 text-xs"
							}`}
							draggable
							onClick={() => onToggleCollapsed(sectionKey)}
							onDragEnd={() => dnd.onDragEnd()}
							onDragStart={(e) => {
								e.dataTransfer.effectAllowed = "move";
								e.dataTransfer.setData("text/plain", sectionKey);
								dnd.onDragStart(sectionKey);
							}}
							type="button"
						>
							{iconNode ??
								(icon && (
									<HugeiconsIcon
										className={`shrink-0 ${size === "md" ? "size-4" : "size-3.5"}`}
										icon={icon}
									/>
								))}
							<span className="min-w-0 truncate">{label}</span>
							{typeof count === "number" && (
								<span
									className={`shrink-0 text-muted-foreground/60 ${action ? "transition-opacity group-hover/subsection:opacity-0" : ""}`}
								>
									{formatCount(count) ?? "—"}
								</span>
							)}
							<HugeiconsIcon
								className={`-ml-0.5 size-3 shrink-0 opacity-0 transition group-hover/hdr:opacity-100 ${collapsed ? "-rotate-90" : ""}`}
								icon={ArrowDown01Icon}
							/>
						</button>
						{action && (
							<div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center">
								{action}
							</div>
						)}
					</div>
				);
				return wrapHeader ? wrapHeader(headerRow) : headerRow;
			})()}
			{!collapsed && <div className="mt-0.5">{children}</div>}
		</div>
	);
}

/**
 * The two localStorage keys one date-bucketed list needs, namespaced by `scope`.
 *
 * Per-scope rather than global because collapse state is per-LIST: collapsing
 * "Older" inside one project must not collapse it inside the next one, and the
 * Chats section's buckets are a third independent surface. Chats itself keeps its
 * ORIGINAL keys (passed explicitly) so nobody's existing collapse state resets when
 * this generalization ships.
 */
function dateBucketStorageKeys(scope: string): {
	collapsedKey: string;
	orderKey: string;
} {
	return {
		collapsedKey: `ryu:sidebar-collapsed-date-buckets:${scope}`,
		orderKey: `ryu:sidebar-date-bucket-order:${scope}`,
	};
}

/**
 * Any list of rows, bucketed by date into collapsible/reorderable sub-sections.
 *
 * The render half of `lib/sidebar/date-buckets.ts` and the reason "group by date" is
 * now a sidebar-wide primitive rather than a property of the Chats section: a caller
 * supplies its rows, the accessor that dates one (`stampOf`), a storage scope, and
 * how to draw a run of them (`renderRows`). Everything else — bucketing, the display
 * zone, per-bucket collapse and drag order — is shared.
 *
 * Returns `null` when there is nothing to bucket, which is the signal for the caller
 * to fall back to its flat body. Hooks run before that return, so the fallback is a
 * render decision, not a conditional-hook hazard.
 *
 * `renderRows` receives one bucket's rows, so a caller keeps its own row component
 * (a chat row, a space document row, a contributed row) unchanged.
 */
function DateGroupedRows<T>({
	className = "space-y-0.5",
	collapsedKey,
	items,
	orderKey,
	renderRows,
	stampOf,
	wrapHeader,
}: {
	/**
	 * Wrapper classes, which in practice means the bucket headers' INDENT. A bucket
	 * is a divider that has to line up with the rows it introduces, and those rows
	 * sit at different depths per surface: a chat row at the section's own indent, a
	 * space document two steps in under its space. Defaults to no indent.
	 */
	className?: string;
	collapsedKey: string;
	items: T[];
	orderKey: string;
	renderRows: (rows: T[]) => ReactNode;
	stampOf: (item: T) => number | string | null | undefined;
	/** Optional wrapper for a bucket's header — e.g. a "Delete all chats" menu
	 *  scoped to that bucket. */
	wrapHeader?: (bucket: DateBucket<T>, header: ReactNode) => ReactNode;
}) {
	// Which bucket a row lands in depends on midnight in the DISPLAY zone, so the
	// revision has to be a dependency — not just a subscription.
	const timezoneRevision = useTimezoneRevision();
	const buckets = useMemo(
		() => bucketByDate(items, stampOf, startOfTodayMs()),
		// biome-ignore lint/correctness/useExhaustiveDependencies: bucketing reads
		// the display zone at call time; the revision is what invalidates it.
		[items, stampOf, timezoneRevision]
	);
	// Keyed by plain string: `useNestedSections` speaks the same string-keyed
	// vocabulary as every other reorderable surface, so the bucket key crosses that
	// boundary widened rather than making the shared machinery generic.
	const bucketByKey = useMemo(
		() => new Map<string, DateBucket<T>>(buckets.map((b) => [b.key, b])),
		[buckets]
	);
	const bucketKeys = useMemo<string[]>(
		() => buckets.map((b) => b.key),
		[buckets]
	);
	const nested = useNestedSections(orderKey, collapsedKey, bucketKeys, false);

	if (buckets.length === 0) {
		return null;
	}

	return (
		<div className={className}>
			{nested.orderedKeys.map((key) => {
				const bucket = bucketByKey.get(key);
				if (!bucket) {
					return null;
				}
				const label = DATE_BUCKET_LABELS[key] ?? bucket.label;
				return (
					<SubSection
						collapsed={nested.isCollapsed(key)}
						count={bucket.items.length}
						dnd={nested.dnd}
						key={key}
						label={label}
						onToggleCollapsed={nested.toggle}
						sectionKey={key}
						wrapHeader={
							wrapHeader ? (header) => wrapHeader(bucket, header) : undefined
						}
					>
						{renderRows(bucket.items)}
					</SubSection>
				);
			})}
		</div>
	);
}

/** A right-click "Delete all chats" affordance for a section or sub-section
 *  header. Wraps the header in a context menu whose destructive item opens a
 *  confirmation dialog; on confirm every conversation in `conversationIds` is
 *  deleted (one optimistic-local removal + one best-effort DELETE apiece — Core
 *  has no bulk endpoint). The menu item is disabled when the group is empty so
 *  the header still gets a menu (rather than falling through to the sidebar-wide
 *  one) but offers nothing destructive to do. */
function DeleteAllChatsMenu({
	children,
	conversationIds,
	groupLabel,
	onDelete,
	scope,
}: {
	children: ReactNode;
	conversationIds: string[];
	/** Human name of the group, e.g. "Today" or "Chats" — used in the copy. */
	groupLabel: string;
	onDelete: (id: string) => void;
	/** "group" → "Delete all chats in {label}"; "all" → "Delete all chats". */
	scope: "all" | "group";
}) {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const count = conversationIds.length;
	const noun = count === 1 ? "chat" : "chats";
	const itemLabel =
		scope === "all" ? "Delete all chats" : `Delete all chats in ${groupLabel}`;
	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger>{children}</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem
						disabled={count === 0}
						onClick={() => setConfirmOpen(true)}
						variant="destructive"
					>
						<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
						{itemLabel}
						{count > 0 && (
							<span className="ml-auto pl-2 text-muted-foreground/70">
								{count}
							</span>
						)}
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
			<AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{scope === "all"
								? `Delete all ${count} ${noun}?`
								: `Delete all ${count} ${noun} in ${groupLabel}?`}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{`This permanently deletes ${count} ${noun}${
								scope === "group" ? ` in "${groupLabel}"` : ""
							}. This cannot be undone.`}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								for (const id of conversationIds) {
									onDelete(id);
								}
							}}
							variant="destructive"
						>
							{`Delete ${count} ${noun}`}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

function BotChatSectionMenu({
	label,
	onDelete,
	onRename,
}: {
	label: string;
	onDelete: () => void;
	onRename: () => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`${label} options`}
				className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/subsection:opacity-100 data-[popup-open]:opacity-100"
				onClick={(event) => event.stopPropagation()}
			>
				<HugeiconsIcon icon={MoreHorizontalIcon} size={14} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onClick={onRename}>
					<HugeiconsIcon className="mr-2" icon={PencilEdit01Icon} size={14} />
					Rename section
				</DropdownMenuItem>
				<DropdownMenuItem onClick={onDelete} variant="destructive">
					<HugeiconsIcon className="mr-2" icon={Delete01Icon} size={14} />
					Delete section
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function BotModeChatSectionsBody({
	handlers,
	loose,
	onAssign,
	onDelete,
	onOpenRename,
	sectionState,
	sections,
}: {
	handlers: ChatRowHandlers;
	loose: Conversation[];
	onAssign: (conversationId: string, sectionId: string) => void;
	onDelete: (sectionId: string) => void;
	onOpenRename: (section: BotChatSection) => void;
	sectionState: BotChatSectionState;
	sections: BotChatSection[];
}) {
	const sectionIds = useMemo(
		() => [UNORGANIZED_SECTION_ID, ...sections.map((section) => section.id)],
		[sections]
	);
	const nested = useNestedSections(
		BOT_CHAT_SECTION_ORDER_KEY,
		BOT_CHAT_SECTION_COLLAPSED_KEY,
		sectionIds,
		false
	);
	const conversationIds = useMemo(
		() => new Set(loose.map((conversation) => conversation.id)),
		[loose]
	);
	const sectionsById = useMemo(
		() => new Map(sections.map((section) => [section.id, section])),
		[sections]
	);

	return (
		<div className="space-y-0.5">
			{nested.orderedKeys.map((sectionId) => {
				const customSection = sectionsById.get(sectionId);
				const isUnorganized = sectionId === UNORGANIZED_SECTION_ID;
				const label = customSection?.name ?? "Unorganized";
				const conversations = conversationsForSection(
					loose,
					sectionState,
					sectionId
				);

				return (
					<SubSection
						action={
							customSection ? (
								<BotChatSectionMenu
									label={label}
									onDelete={() => onDelete(customSection.id)}
									onRename={() => onOpenRename(customSection)}
								/>
							) : undefined
						}
						collapsed={nested.isCollapsed(sectionId)}
						count={conversations.length}
						dnd={nested.dnd}
						icon={isUnorganized ? FolderOpenIcon : Folder01Icon}
						key={sectionId}
						label={label}
						onToggleCollapsed={nested.toggle}
						sectionKey={sectionId}
						size="md"
						testId={`bot-chat-section-${sectionId}`}
						visibilityDrop={{
							accept: "chat",
							canDrop: (payload) => conversationIds.has(payload.id),
							onDrop: (payload) => onAssign(payload.id, sectionId),
						}}
					>
						{conversations.length > 0 ? (
							<ChatRowList conversations={conversations} handlers={handlers} />
						) : (
							<p className="px-2 py-2 text-muted-foreground text-xs">
								{isUnorganized ? "No unorganized chats" : "Drop a chat here"}
							</p>
						)}
					</SubSection>
				);
			})}
		</div>
	);
}

type BotChatSectionDialogState =
	| { id: null; initialName: string; mode: "create" }
	| { id: string; initialName: string; mode: "rename" };

export function ChatsSection({
	botMode,
	collapsed,
	dnd,
	handlers,
	loose,
	managedProduct = false,
	menu,
	onImport,
	onImportSetup,
	onNew,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps & {
	botMode: boolean;
	handlers: ChatRowHandlers;
	loose: Conversation[];
	managedProduct?: boolean;
	/** Open the "import a past agent thread" dialog (Claude Code / Codex). */
	onImport?: () => void;
	/** Open the "import agent setup from a folder" dialog. */
	onImportSetup?: () => void;
	onNew: () => void;
}) {
	const botChatSections = useBotChatSections();
	const [sectionDialog, setSectionDialog] =
		useState<BotChatSectionDialogState | null>(null);
	const botChatSectionState = useMemo<BotChatSectionState>(
		() => ({
			assignments: botChatSections.assignments,
			sections: botChatSections.sections,
		}),
		[botChatSections.assignments, botChatSections.sections]
	);
	const [groupByDate] = useChatDateGrouping();
	const chatsByVisibility = useMemo(
		() =>
			loose.reduce<Record<ResourceVisibilityGroup, Conversation[]>>(
				(groups, conversation) => {
					groups[resourceVisibilityGroup(conversation.visibility)].push(
						conversation
					);
					return groups;
				},
				{ private: [], team: [] }
			),
		[loose]
	);
	const visibilityGroupKeys = useMemo(
		() => ["private", "team"] as ResourceVisibilityGroup[],
		[]
	);
	const visibilityGroups = useNestedSections(
		CHAT_VISIBILITY_ORDER_KEY,
		CHAT_VISIBILITY_COLLAPSED_KEY,
		visibilityGroupKeys,
		false
	);
	const privatePaged = usePaged(
		sortItems(chatsByVisibility.private, sort, CONV_SORT_ACCESSORS),
		pageSize
	);
	const teamPaged = usePaged(
		sortItems(chatsByVisibility.team, sort, CONV_SORT_ACCESSORS),
		pageSize
	);

	const renderVisibilityGroup = (group: ResourceVisibilityGroup) => {
		const groupChats = chatsByVisibility[group];
		const groupPaged = group === "private" ? privatePaged : teamPaged;
		const label = group === "private" ? "Private" : "Team";
		return (
			<SubSection
				collapsed={visibilityGroups.isCollapsed(group)}
				count={groupChats.length}
				dnd={visibilityGroups.dnd}
				icon={group === "private" ? ViewOffSlashIcon : UserMultiple02Icon}
				key={group}
				label={label}
				onToggleCollapsed={visibilityGroups.toggle}
				sectionKey={group}
				size="md"
				visibilityDrop={{
					accept: "chat",
					canDrop: () => group !== "private" || handlers.canMakePrivate,
					canDropOnDragOver: () =>
						group !== "private" || handlers.canMakePrivate,
					onDrop: (payload) =>
						handlers.onRequestConversationVisibility({
							...payload,
							to: group,
						}),
				}}
				wrapHeader={(header) => (
					<DeleteAllChatsMenu
						conversationIds={groupChats.map((conversation) => conversation.id)}
						groupLabel={`${label} chats`}
						onDelete={handlers.onDeleteConversation}
						scope="group"
					>
						{header}
					</DeleteAllChatsMenu>
				)}
			>
				{groupByDate ? (
					<SidebarChatList
						conversations={groupChats}
						handlers={handlers}
						scope={`loose:${group}`}
					/>
				) : (
					<>
						<ChatRowList
							conversations={groupPaged.visible}
							handlers={handlers}
						/>
						<SectionPagingControls
							overflow={{
								getSearchText: (conversation) => conversation.title ?? "",
								items: groupPaged.items,
								label: `${label.toLowerCase()} chats`,
								renderList: (list) => (
									<ChatRowList conversations={list} handlers={handlers} />
								),
							}}
							paged={groupPaged}
						/>
					</>
				)}
			</SubSection>
		);
	};
	const orderedVisibilityGroups = visibilityGroups.orderedKeys.filter(
		(key): key is ResourceVisibilityGroup => key === "private" || key === "team"
	);

	const openCreateSection = () =>
		setSectionDialog({ id: null, initialName: "", mode: "create" });
	const openRenameSection = (section: BotChatSection) =>
		setSectionDialog({
			id: section.id,
			initialName: section.name,
			mode: "rename",
		});
	const submitSectionDialog = (name: string) => {
		if (!sectionDialog) {
			return;
		}
		if (sectionDialog.mode === "create") {
			botChatSections.createSection(name);
		} else {
			botChatSections.renameSection(sectionDialog.id, name);
		}
	};

	return (
		<>
			<SidebarSection
				action={
					// Two actions, spaced exactly like every single-action section: each
					// button carries the same `mr-1` {@link SectionAddButton} puts between
					// itself and the overflow "…" trigger, so import → + → … are evenly
					// pitched instead of the + hugging the import button.
					<>
						{botMode && !managedProduct ? (
							<span className="mr-1">
								<SectionActionButton
									icon={FolderAddIcon}
									onClick={openCreateSection}
									title="New section"
								/>
							</span>
						) : null}
						{onImport ? (
							<span className="mr-1">
								<SectionActionButton
									icon={Upload01Icon}
									onClick={onImport}
									title="Import a past agent thread"
								/>
							</span>
						) : null}
						{onImportSetup ? (
							<span className="mr-1">
								<SectionActionButton
									icon={Settings03Icon}
									onClick={onImportSetup}
									title="Import agent setup from a folder"
								/>
							</span>
						) : null}
						<SectionAddButton onClick={onNew} title="New chat" />
					</>
				}
				collapsed={collapsed}
				dnd={dnd}
				label="Chats"
				menu={menu}
				onToggleCollapsed={onToggleCollapsed}
				pageSize={pageSize}
				sectionKey="chats"
				sort={sort}
				wrapHeader={(header) => (
					<DeleteAllChatsMenu
						conversationIds={loose.map((c) => c.id)}
						groupLabel="Chats"
						onDelete={handlers.onDeleteConversation}
						scope="all"
					>
						{header}
					</DeleteAllChatsMenu>
				)}
			>
				{botMode ? (
					<BotModeChatSectionsBody
						handlers={handlers}
						loose={loose}
						onAssign={botChatSections.assignConversation}
						onDelete={botChatSections.deleteSection}
						onOpenRename={openRenameSection}
						sectionState={botChatSectionState}
						sections={botChatSections.sections}
					/>
				) : loose.length === 0 ? (
					<p className="px-2 py-2 text-muted-foreground text-xs">
						No chats yet
					</p>
				) : (
					orderedVisibilityGroups.map(renderVisibilityGroup)
				)}
			</SidebarSection>
			<BotChatSectionDialog
				initialName={sectionDialog?.initialName}
				mode={sectionDialog?.mode ?? "create"}
				onOpenChange={(open) => {
					if (!open) {
						setSectionDialog(null);
					}
				}}
				onSubmit={submitSectionDialog}
				open={sectionDialog !== null}
			/>
		</>
	);
}

// Per-project expand/collapse inside the single Projects section, persisted so a
// folder you opened stays open across reloads (independent of the Projects
// section's own collapse). Keyed by folder path.
const PROJECT_EXPANDED_KEY = "ryu:sidebar-expanded-projects";

/** Sort projects by folder name or by the recency of their newest chat (empty
 *  projects sort to the bottom for the recency options). */
const PROJECT_SORT_ACCESSORS: SortAccessors<ProjectBucket> = {
	created: (p) =>
		p.conversations.reduce((max, c) => Math.max(max, toEpoch(c.createdAt)), 0),
	name: (p) => p.name,
	updated: (p) =>
		p.conversations.reduce((max, c) => Math.max(max, toEpoch(c.updatedAt)), 0),
};

/**
 * Any run of chats in the sidebar, date-bucketed when the user's "Group lists by
 * date" setting is on and flat otherwise.
 *
 * This is what makes the setting universal rather than Chats-only. Every chat list
 * outside the Chats section itself goes through here — an expanded project row, the
 * picker's "All projects" and single-project bodies, Pinned, Archived — so date
 * grouping cannot be on in one place and quietly missing in another.
 *
 * `scope` namespaces the bucket collapse/order state: collapsing "Older" under one
 * project must not collapse it under every other one, nor under Pinned.
 */
export function SidebarChatList({
	conversations,
	handlers,
	scope,
}: {
	conversations: Conversation[];
	handlers: ChatRowHandlers;
	scope: string;
}) {
	const [groupByDate] = useChatDateGrouping();
	const storage = dateBucketStorageKeys(`chats:${scope}`);
	const renderRows = (list: Conversation[]) => (
		<ChatRowList conversations={list} handlers={handlers} />
	);
	if (!groupByDate) {
		return renderRows(conversations);
	}
	return (
		<DateGroupedRows
			className="ml-2 space-y-0.5"
			collapsedKey={storage.collapsedKey}
			items={conversations}
			// REMOUNT on a scope change. `useNestedSections` loads both storage keys in
			// `useState` initializers only, and this element keeps its tree position
			// when the picker switches project — so without a changing key the buckets
			// would carry the previous scope's collapse set and the next toggle would
			// write it to the NEW scope's key, which is the exact cross-contamination
			// the per-scope keys exist to prevent.
			key={storage.orderKey}
			orderKey={storage.orderKey}
			renderRows={renderRows}
			stampOf={conversationStamp}
			wrapHeader={(bucket, header) => (
				<DeleteAllChatsMenu
					conversationIds={bucket.items.map((c) => c.id)}
					groupLabel={bucket.label}
					onDelete={handlers.onDeleteConversation}
					scope="group"
				>
					{header}
				</DeleteAllChatsMenu>
			)}
		/>
	);
}

/** One nested folder inside the Projects section, rendered with the shared
 *  sub-section header (collapsible + drag-reorderable), expanding to its chats
 *  (or a "No chats" hint), with set-active / remove in the context menu. */
function ProjectRow({
	bucket,
	collapsed,
	dnd,
	handlers,
	onNewChat,
	onRemove,
	onSetActive,
	onToggleCollapsed,
}: {
	bucket: ProjectBucket;
	collapsed: boolean;
	dnd: SubSectionDnd;
	handlers: ChatRowHandlers;
	/** Start a fresh chat rooted in this folder (activates the folder first). */
	onNewChat: (path: string) => void;
	onRemove: (path: string) => void;
	onSetActive: (path: string) => void;
	onToggleCollapsed: (key: string) => void;
}) {
	const count = bucket.conversations.length;
	const customIcon = useWorkspaceStore(
		(state) => state.projectIcons[bucket.path]
	);
	const customName = useWorkspaceStore(
		(state) => state.projectNames[bucket.path]
	);
	const label = customName?.trim() || bucket.name;
	const [iconDialogOpen, setIconDialogOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
	const { openTab } = useTabsContext();
	const openProjectView = (kind: "diff" | "files" | "graph") => {
		const path = `/project/${kind}/${encodeURIComponent(bucket.path)}`;
		const title =
			kind === "diff" ? "Changes" : kind === "files" ? "Files" : "Git graph";
		openTab(path, {
			title: `${title} · ${label}`,
		});
	};
	const noun = count === 1 ? "chat" : "chats";
	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger>
					<SubSection
						action={
							<div className="flex items-center gap-0.5">
								<SubSectionActionButton
									icon={Add01Icon}
									onClick={() => onNewChat(bucket.path)}
									title="New chat in this folder"
								/>
								<SubSectionActionButton
									icon={FileCodeIcon}
									onClick={() => openProjectView("diff")}
									title="Open project changes"
								/>
								<SubSectionActionButton
									icon={FolderOpenIcon}
									onClick={() => openProjectView("files")}
									title="Browse project files"
								/>
								<SubSectionActionButton
									icon={GitBranchIcon}
									onClick={() => openProjectView("graph")}
									title="Open Git graph"
								/>
							</div>
						}
						collapsed={collapsed}
						count={count}
						dnd={dnd}
						icon={collapsed ? Folder01Icon : Folder03Icon}
						iconNode={
							customIcon ? (
								<ProjectGlyph fallback={null} icon={customIcon} />
							) : undefined
						}
						label={label}
						onToggleCollapsed={onToggleCollapsed}
						sectionKey={bucket.path}
						size="md"
					>
						{bucket.sourceFolders.length > 1 && (
							<div className="mb-1 space-y-0.5 px-2 text-[10px] text-muted-foreground">
								<div className="font-medium uppercase tracking-wide">
									Sources
								</div>
								{bucket.sourceFolders.map((source) => (
									<div
										className="truncate font-mono"
										key={source}
										title={source}
									>
										{source}
									</div>
								))}
							</div>
						)}
						{count === 0 ? (
							<p className="px-2 py-1 text-muted-foreground/70 text-xs">
								No chats
							</p>
						) : (
							<SidebarChatList
								conversations={bucket.conversations}
								handlers={handlers}
								scope={bucket.path}
							/>
						)}
					</SubSection>
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem onClick={() => setSettingsOpen(true)}>
						<HugeiconsIcon className="mr-2 size-4" icon={PencilEdit01Icon} />
						Edit project…
					</ContextMenuItem>
					<ContextMenuItem onClick={() => onSetActive(bucket.path)}>
						<HugeiconsIcon className="mr-2 size-4" icon={FolderOpenIcon} />
						Set as active project
					</ContextMenuItem>
					<ContextMenuItem onClick={() => setIconDialogOpen(true)}>
						<HugeiconsIcon className="mr-2 size-4" icon={ImageAdd01Icon} />
						Change icon…
					</ContextMenuItem>
					<ContextMenuItem onClick={() => openProjectView("graph")}>
						<HugeiconsIcon className="mr-2 size-4" icon={GitBranchIcon} />
						Open Git graph
					</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem
						disabled={count === 0}
						onClick={() => setConfirmDeleteOpen(true)}
						variant="destructive"
					>
						<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
						Delete all chats
						{count > 0 && (
							<span className="ml-auto pl-2 text-muted-foreground/70">
								{count}
							</span>
						)}
					</ContextMenuItem>
					<ContextMenuItem
						onClick={() => onRemove(bucket.path)}
						variant="destructive"
					>
						<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
						Remove from app
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
			<ProjectSettingsDialog
				onOpenChange={setSettingsOpen}
				open={settingsOpen}
				path={bucket.path}
			/>
			<ProjectIconDialog
				name={label}
				onOpenChange={setIconDialogOpen}
				open={iconDialogOpen}
				path={bucket.path}
			/>
			<AlertDialog onOpenChange={setConfirmDeleteOpen} open={confirmDeleteOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{`Delete all ${count} ${noun} in ${label}?`}</AlertDialogTitle>
						<AlertDialogDescription>
							{`This permanently deletes ${count} ${noun} in the "${label}" project. The project folder itself is untouched. This cannot be undone.`}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								for (const conv of bucket.conversations) {
									handlers.onDeleteConversation(conv.id);
								}
							}}
							variant="destructive"
						>
							{`Delete ${count} ${noun}`}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

/**
 * The selected project's verbs, for the picker model.
 *
 * Every item here used to live on {@link ProjectRow}'s context menu. "Set as active
 * project" in particular is not a convenience — it is what the composer's project
 * picker and a run's cwd follow — so the picker model could not simply drop it and
 * call itself a decluttering. Only rendered when a single project is selected: none
 * of these verbs mean anything applied to "all".
 */
function ProjectScopeMenu({
	label,
	onNewChat,
	onOpenGraph,
	onRemove,
	onSetActive,
	path,
}: {
	label: string;
	onNewChat: (path: string) => void;
	onOpenGraph: (path: string) => void;
	onRemove: (path: string) => void;
	onSetActive: (path: string) => void;
	path: string;
}) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [iconDialogOpen, setIconDialogOpen] = useState(false);
	return (
		<>
			<ScopeMenu label={`${label} options`}>
				<DropdownMenuItem onClick={() => onNewChat(path)}>
					<HugeiconsIcon className="mr-2 size-4" icon={Add01Icon} />
					New chat in this folder
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => onOpenGraph(path)}>
					<HugeiconsIcon className="mr-2 size-4" icon={GitBranchIcon} />
					Open Git graph
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => onSetActive(path)}>
					<HugeiconsIcon className="mr-2 size-4" icon={FolderOpenIcon} />
					Set as active project
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => setSettingsOpen(true)}>
					<HugeiconsIcon className="mr-2 size-4" icon={PencilEdit01Icon} />
					Edit project…
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => setIconDialogOpen(true)}>
					<HugeiconsIcon className="mr-2 size-4" icon={ImageAdd01Icon} />
					Change icon…
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={() => onRemove(path)} variant="destructive">
					<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
					Remove from app
				</DropdownMenuItem>
			</ScopeMenu>
			{/* Outside the menu so they survive it closing on select. */}
			<ProjectSettingsDialog
				onOpenChange={setSettingsOpen}
				open={settingsOpen}
				path={path}
			/>
			<ProjectIconDialog
				name={label}
				onOpenChange={setIconDialogOpen}
				open={iconDialogOpen}
				path={path}
			/>
		</>
	);
}

/**
 * The selected space's verbs, for the picker model — the {@link SpaceSidebarRow}
 * context menu and its hover `+`, rehoused.
 *
 * "Add files" matters most: `AddToSpaceDialog` is the sidebar's only path for
 * uploading into a space, and it needs a target, so without this the picker model
 * would have removed the feature rather than tidied it. The system-space branch on
 * delete is preserved verbatim in intent — Core refuses to delete one, so the item
 * is disabled with the reason rather than hidden.
 */
export function SpaceScopeMenu({
	canDelete,
	canMakePrivate,
	contributedRows,
	onAdd,
	onOpen,
	onOpenInNewTab,
	onOpenInNewWindow,
	onRequestDelete,
	onRename,
	onRequestVisibilityChange,
	setSpaceIcon,
	space,
}: {
	canDelete: boolean;
	canMakePrivate: boolean;
	contributedRows: EntityRow[];
	onAdd: () => void;
	onOpen: () => void;
	onOpenInNewTab: () => void;
	onOpenInNewWindow: () => void;
	onRequestDelete: () => void;
	onRename: (name: string) => Promise<void>;
	onRequestVisibilityChange: (request: VisibilityChangeRequest) => void;
	setSpaceIcon: (id: string, icon: GlyphValue) => Promise<void>;
	space: Space;
}) {
	const { updateTabsIconWhere } = useTabsContext();
	const [iconDialogOpen, setIconDialogOpen] = useState(false);
	const [renameOpen, setRenameOpen] = useState(false);
	return (
		<>
			<ScopeMenu label={`${space.name} options`}>
				<DropdownMenuItem onClick={onAdd}>
					<HugeiconsIcon className="mr-2 size-4" icon={Add01Icon} />
					Add files to this space…
				</DropdownMenuItem>
				<DropdownMenuItem onClick={onOpen}>
					<HugeiconsIcon className="mr-2 size-4" icon={DeliverySecure01Icon} />
					Open space page
				</DropdownMenuItem>
				<DropdownMenuItem onClick={onOpenInNewTab}>
					<HugeiconsIcon className="mr-2 size-4" icon={ArrowUpRight01Icon} />
					Open in new tab
				</DropdownMenuItem>
				<OpenInNewWindowDropdownMenuItem onClick={onOpenInNewWindow} />
				<DropdownMenuItem onClick={() => setIconDialogOpen(true)}>
					<HugeiconsIcon className="mr-2 size-4" icon={ImageAdd01Icon} />
					Change icon…
				</DropdownMenuItem>
				{space.system ? null : (
					<DropdownMenuItem onClick={() => setRenameOpen(true)}>
						<HugeiconsIcon className="mr-2 size-4" icon={PencilEdit01Icon} />
						Rename space
					</DropdownMenuItem>
				)}
				{space.system ? null : (
					<DropdownMenuItem
						disabled={
							resourceVisibilityGroup(space.visibility) === "team" &&
							!canMakePrivate
						}
						onClick={() =>
							onRequestVisibilityChange({
								from: resourceVisibilityGroup(space.visibility),
								id: space.id,
								name: space.name,
								resourceType: "space",
								to:
									resourceVisibilityGroup(space.visibility) === "team"
										? "private"
										: "team",
							})
						}
					>
						<HugeiconsIcon
							className="mr-2 size-4"
							icon={
								resourceVisibilityGroup(space.visibility) === "team"
									? ViewOffSlashIcon
									: UserMultiple02Icon
							}
						/>
						{resourceVisibilityGroup(space.visibility) === "team"
							? canMakePrivate
								? "Make private"
								: "Make private (admins only)"
							: "Share with team"}
					</DropdownMenuItem>
				)}
				{contributedRows.map((row) => (
					<DropdownMenuItem key={row.id} onClick={row.onSelect}>
						<span className="mr-2 inline-flex">
							<EntityRowGlyph row={row} />
						</span>
						{row.label}
					</DropdownMenuItem>
				))}
				<DropdownMenuSeparator />
				{space.system || !canDelete ? (
					<Tooltip>
						<TooltipTrigger render={<span className="block" />}>
							<DropdownMenuItem disabled variant="destructive">
								<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
								Delete space
							</DropdownMenuItem>
						</TooltipTrigger>
						<TooltipContent className="max-w-56">
							{space.system
								? "System spaces can't be deleted — Ryu creates and maintains this one."
								: "Only organization members with Space delete permission can delete Spaces."}
						</TooltipContent>
					</Tooltip>
				) : (
					<DropdownMenuItem onClick={onRequestDelete} variant="destructive">
						<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
						Delete space
					</DropdownMenuItem>
				)}
			</ScopeMenu>
			<EntityIconDialog
				description={space.name}
				onChange={(next) => {
					updateTabsIconWhere((t) => t.path === `/spaces/${space.id}`, next);
					void setSpaceIcon(space.id, next).catch(() => {
						toast.error("Couldn't update space icon");
					});
				}}
				onOpenChange={setIconDialogOpen}
				open={iconDialogOpen}
				title="Space icon"
				value={space.icon}
			/>
			<RenameSpaceDialog
				onClose={() => setRenameOpen(false)}
				onRename={onRename}
				open={renameOpen}
				space={space}
			/>
		</>
	);
}

/**
 * A project's chats under the picker, paged.
 *
 * Unlike the Chats section — which buckets every loose chat and leaves paging to its
 * flat body — the picker's "All projects" list is the union of EVERY project's chats,
 * so it is paged in both models. Bucketing an unbounded union would put an unbounded
 * number of rows in the sidebar the moment the setting is on.
 */
function ProjectsPickerBody({
	handlers,
	pageSize,
	projects,
	scope,
	sort,
}: {
	handlers: ChatRowHandlers;
	pageSize: number;
	/** The chats to show: one project's, or every project's. */
	projects: ProjectBucket[];
	/** Namespaces the date-bucket collapse state for this selection. */
	scope: string;
	sort: SortKey;
}) {
	// Newest-first across the union, so "All projects" reads chronologically rather
	// than project-by-project. `sort` then re-orders it if the user picked one.
	const conversations = useMemo(() => {
		const all = projects.flatMap((p) => p.conversations);
		return all.sort((a, b) => toEpoch(b.updatedAt) - toEpoch(a.updatedAt));
	}, [projects]);
	const paged = usePaged(
		sortItems(conversations, sort, CONV_SORT_ACCESSORS),
		pageSize
	);

	if (conversations.length === 0) {
		return (
			<p className="px-2 py-2 text-muted-foreground text-xs">
				{scope === ALL_SELECTION
					? "No chats in your projects yet"
					: "No chats in this project yet"}
			</p>
		);
	}

	return (
		<>
			<SidebarChatList
				conversations={paged.visible}
				handlers={handlers}
				scope={scope}
			/>
			<SectionPagingControls
				overflow={{
					getSearchText: (c) => c.title ?? "",
					items: paged.items,
					label: "chats",
					renderList: (list) => (
						<ChatRowList conversations={list} handlers={handlers} />
					),
				}}
				paged={paged}
			/>
		</>
	);
}

/** Every project as its own expandable row — the original model, kept behind the
 *  "Projects & Spaces as pickers" setting. */
function ProjectsListBody({
	handlers,
	onNewChat,
	onRemove,
	onSetActive,
	pageSize,
	projects,
	sort,
}: {
	handlers: ChatRowHandlers;
	onNewChat: (path: string) => void;
	onRemove: (path: string) => void;
	onSetActive: (path: string) => void;
	pageSize: number;
	projects: ProjectBucket[];
	sort: SortKey;
}) {
	// Folders default collapsed; the section's Sort-by seeds their order, and the
	// user can drag to override it (persisted per folder path).
	const sortedProjects = sortItems(projects, sort, PROJECT_SORT_ACCESSORS);
	const projectByPath = useMemo(
		() => new Map(sortedProjects.map((p) => [p.path, p])),
		[sortedProjects]
	);
	const projectPaths = useMemo(
		() => sortedProjects.map((p) => p.path),
		[sortedProjects]
	);
	const nested = useNestedSections(
		PROJECT_ORDER_KEY,
		PROJECT_EXPANDED_KEY,
		projectPaths,
		true
	);
	const paged = usePaged(nested.orderedKeys, pageSize);

	const renderProjectRows = (list: typeof nested.orderedKeys) =>
		list.map((path) => {
			const bucket = projectByPath.get(path);
			if (!bucket) {
				return null;
			}
			return (
				<ProjectRow
					bucket={bucket}
					collapsed={nested.isCollapsed(path)}
					dnd={nested.dnd}
					handlers={handlers}
					key={path}
					onNewChat={onNewChat}
					onRemove={onRemove}
					onSetActive={onSetActive}
					onToggleCollapsed={nested.toggle}
				/>
			);
		});

	// No `ml-2` here, unlike the Chats date buckets. Those buckets are dividers
	// INSIDE a section, so the indent says "these belong to Chats"; a project folder
	// is a top-level entity like a chat or a space, and indenting it left a gap on
	// the left edge that nothing else in the sidebar has.
	return (
		<>
			<div className="space-y-0.5">{renderProjectRows(paged.visible)}</div>
			<SectionPagingControls
				overflow={{
					getSearchText: (path) => path,
					items: paged.items,
					label: "projects",
					renderList: (list) => (
						<div className="space-y-0.5">{renderProjectRows(list)}</div>
					),
				}}
				paged={paged}
			/>
		</>
	);
}

/** All workspace projects under one section. The list is the union of the composer's
 *  recent folders and the folders of existing conversations (minus any the user
 *  removed) — the same synced store the project picker reads, so importing or
 *  removing in either surface reflects in both.
 *
 *  Two presentations, chosen by the "Projects & Spaces as pickers" setting: a picker
 *  whose default option ("All projects") lists every chat across every project, or
 *  the original row-per-project list where folders with no chats still show with a
 *  "No chats" hint. */
function ProjectsSection({
	collapsed,
	dnd,
	handlers,
	menu,
	onToggleCollapsed,
	pageSize,
	projects,
	sort,
}: SectionProps & {
	handlers: ChatRowHandlers;
	projects: ProjectBucket[];
}) {
	const { setFolder, removeProject } = useWorkspaceStore();
	const { openTab } = useTabsContext();
	const [groupedNav] = useSidebarGroupedNav();
	const projectNames = useWorkspaceStore((state) => state.projectNames);
	const options = useMemo(
		() =>
			projects.map((p) => ({
				label: projectNames[p.path]?.trim() || p.name,
				value: p.path,
			})),
		[projects, projectNames]
	);
	const [selection, setSelection] = usePickerSelection(
		PROJECT_SELECTION_KEY,
		options
	);
	// What the picker is currently showing — the one selected project, or all of
	// them. Also the scope of the header's "Delete all chats": a header action that
	// reached past the visible list would be a destructive scope mismatch.
	const shown = useMemo(
		() =>
			selection === ALL_SELECTION
				? projects
				: projects.filter((p) => p.path === selection),
		[projects, selection]
	);
	const headerScope = groupedNav ? shown : projects;

	// The `+` opens the SAME dropdown as the composer's folder picker — recent
	// folders, "Open existing folder" (the node-aware NodeFolderBrowser), and
	// "Clone from GitHub", and "Start from scratch" — by reusing
	// ProjectPickerContent. The create/browse/clone dialogs live OUTSIDE the menu
	// so they survive it closing on select.
	const [menuOpen, setMenuOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [browseOpen, setBrowseOpen] = useState(false);
	const [cloneOpen, setCloneOpen] = useState(false);
	const handleSelectBrowsed = (selected: string) => {
		// no-op on failure: never drop the folder here (removal is explicit only).
		setFolder(selected).catch(() => {
			// no-op
		});
	};

	// Activating a folder must NOT remove it on failure — removal is the row's
	// explicit remove action only. A transient failure leaves the row in place.
	const handleSetActive = (path: string) => {
		setFolder(path).catch(() => {
			// no-op
		});
	};

	// Start a fresh chat rooted in a folder: activate it (so the composer's
	// project picker and the run's cwd point at it), then open a new chat tab.
	// Awaiting `setFolder` first guarantees the new chat's first message runs
	// against this folder, not whatever was previously active. A failed activation
	// still opens the chat and never removes the folder.
	const handleNewChatInFolder = async (path: string) => {
		await setFolder(path).catch(() => {
			// no-op
		});
		openTab("/chat", { forceNew: true });
	};
	const handleOpenGraph = (path: string) => {
		const project = projects.find((item) => item.path === path);
		const label = projectNames[path]?.trim() || project?.name || path;
		openTab(`/project/graph/${encodeURIComponent(path)}`, {
			title: `Git graph · ${label}`,
		});
	};

	return (
		<>
			<SidebarSection
				action={
					<span className="mr-1">
						<DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
							<DropdownMenuTrigger
								render={
									<button
										aria-label="Add project"
										className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/section:opacity-100 data-[popup-open]:opacity-100"
										type="button"
									/>
								}
							>
								<HugeiconsIcon icon={Add01Icon} size={14} />
							</DropdownMenuTrigger>
							<DropdownMenuContent
								align="start"
								className="max-h-[60vh] w-64 overflow-y-auto"
								side="bottom"
								sideOffset={6}
							>
								<ProjectPickerContent
									onBrowse={() => {
										setMenuOpen(false);
										setBrowseOpen(true);
									}}
									onClone={() => {
										setMenuOpen(false);
										setCloneOpen(true);
									}}
									onClose={() => setMenuOpen(false)}
									onStartFromScratch={() => {
										setMenuOpen(false);
										setCreateOpen(true);
									}}
								/>
							</DropdownMenuContent>
						</DropdownMenu>
					</span>
				}
				collapsed={collapsed}
				dnd={dnd}
				label="Projects"
				menu={menu}
				onToggleCollapsed={onToggleCollapsed}
				pageSize={pageSize}
				sectionKey="projects"
				sort={sort}
				wrapHeader={(header) => (
					<DeleteAllChatsMenu
						conversationIds={headerScope.flatMap((p) =>
							p.conversations.map((c) => c.id)
						)}
						groupLabel="Projects"
						onDelete={handlers.onDeleteConversation}
						scope="all"
					>
						{header}
					</DeleteAllChatsMenu>
				)}
			>
				{projects.length === 0 ? (
					<p className="px-2 py-2 text-muted-foreground text-xs">
						No projects yet. Click + to import a folder.
					</p>
				) : groupedNav ? (
					<>
						<SidebarScopePicker
							actions={
								selection === ALL_SELECTION ? undefined : (
									<ProjectScopeMenu
										label={
											options.find((o) => o.value === selection)?.label ??
											selection
										}
										onNewChat={handleNewChatInFolder}
										onOpenGraph={handleOpenGraph}
										onRemove={removeProject}
										onSetActive={handleSetActive}
										path={selection}
									/>
								)
							}
							allLabel="All projects"
							icon={SECTION_ICONS.projects}
							onValueChange={setSelection}
							options={options}
							value={selection}
						/>
						<ProjectsPickerBody
							handlers={handlers}
							pageSize={pageSize}
							projects={shown}
							scope={selection}
							sort={sort}
						/>
					</>
				) : (
					<ProjectsListBody
						handlers={handlers}
						onNewChat={handleNewChatInFolder}
						onRemove={removeProject}
						onSetActive={handleSetActive}
						pageSize={pageSize}
						projects={projects}
						sort={sort}
					/>
				)}
			</SidebarSection>
			<CreateFolderDialog onOpenChange={setCreateOpen} open={createOpen} />
			<CloneFolderDialog onOpenChange={setCloneOpen} open={cloneOpen} />
			<NodeFolderBrowser
				onOpenChange={setBrowseOpen}
				onSelect={handleSelectBrowsed}
				open={browseOpen}
			/>
		</>
	);
}

/** Archived chats — a top-level section, consistent with the others. Hidden
 *  when empty; starts collapsed so it stays out of the way until needed. */
function ArchivedSection({
	archived,
	collapsed,
	dnd,
	handlers,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps & {
	archived: Conversation[];
	handlers: ChatRowHandlers;
}) {
	const paged = usePaged(
		sortItems(archived, sort, CONV_SORT_ACCESSORS),
		pageSize
	);
	if (archived.length === 0) {
		return null;
	}
	return (
		<SidebarSection
			collapsed={collapsed}
			dnd={dnd}
			label="Archived"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="archived"
			sort={sort}
		>
			<SidebarChatList
				conversations={paged.visible}
				handlers={handlers}
				scope="archived"
			/>
			<SectionPagingControls
				overflow={{
					getSearchText: (c) => c.title ?? "",
					items: paged.items,
					label: "archived chats",
					renderList: (list) => (
						<ChatRowList conversations={list} handlers={handlers} />
					),
				}}
				paged={paged}
			/>
		</SidebarSection>
	);
}

/** Drag-and-drop wiring threaded into every reorderable header button. Mirrors
 *  SectionDnd, but rides its own state so a button drag can never land between
 *  the content sections below (and vice-versa). */
interface ChromeDnd {
	draggingKey: ChromeKey | null;
	dragOverKey: ChromeKey | null;
	onDragEnd: () => void;
	onDragOver: (key: ChromeKey) => void;
	onDragStart: (key: ChromeKey) => void;
	onDrop: (key: ChromeKey) => void;
	/** Current button order, so a target can tell which edge to draw the drop line. */
	order: ChromeKey[];
}

/** The header-button context-menu actions: move within the button stack or hide. */
interface ChromeMenu {
	canMove: (key: ChromeKey, dir: "up" | "down") => boolean;
	onHide: (key: ChromeKey) => void;
	onMove: (key: ChromeKey, dir: "up" | "down") => void;
}

/** Shared "Move up / Move down / Hide" items for a header button's context menu,
 *  mirroring the per-section overflow menu so the two surfaces match. */
function ChromeMenuItems({
	chromeKey,
	label,
	menu,
}: {
	chromeKey: ChromeKey;
	label: string;
	menu: ChromeMenu;
}) {
	return (
		<>
			<ContextMenuItem
				disabled={!menu.canMove(chromeKey, "up")}
				onClick={() => menu.onMove(chromeKey, "up")}
			>
				<HugeiconsIcon className="mr-2 size-4" icon={ArrowUp01Icon} />
				Move up
			</ContextMenuItem>
			<ContextMenuItem
				disabled={!menu.canMove(chromeKey, "down")}
				onClick={() => menu.onMove(chromeKey, "down")}
			>
				<HugeiconsIcon className="mr-2 size-4" icon={ArrowDown01Icon} />
				Move down
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem onClick={() => menu.onHide(chromeKey)}>
				<HugeiconsIcon className="mr-2 size-4" icon={ViewOffSlashIcon} />
				Hide {label}
			</ContextMenuItem>
		</>
	);
}

/** Wraps a header button in a right-click menu (move/hide) — used by the buttons
 *  that aren't NavTabButton (New chat, Search). The matching show toggle lives in
 *  the customize dialog. */
function ChromeHideMenu({
	children,
	chromeKey,
	label,
	menu,
}: {
	children: ReactNode;
	chromeKey: ChromeKey;
	label: string;
	menu: ChromeMenu;
}) {
	return (
		<ContextMenu>
			<ContextMenuTrigger>{children}</ContextMenuTrigger>
			<ContextMenuContent>
				<ChromeMenuItems chromeKey={chromeKey} label={label} menu={menu} />
			</ContextMenuContent>
		</ContextMenu>
	);
}

/** Draggable shell around a single header button: handles the reorder gesture and
 *  the drop indicator, leaving the button itself to render via `children`. The li
 *  is the drag source so any button (whatever its inner structure) reorders the
 *  same way; the inner button's own click/middle-click still fire (the browser
 *  suppresses the click that follows a real drag). */
function ChromeButtonShell({
	children,
	chromeKey,
	dnd,
}: {
	children: ReactNode;
	chromeKey: ChromeKey;
	dnd: ChromeDnd;
}) {
	const isDragOver =
		dnd.dragOverKey === chromeKey &&
		dnd.draggingKey !== null &&
		dnd.draggingKey !== chromeKey;
	const isDragging = dnd.draggingKey === chromeKey;
	const dropBelow =
		isDragOver &&
		dnd.draggingKey !== null &&
		dnd.order.indexOf(dnd.draggingKey) < dnd.order.indexOf(chromeKey);
	return (
		<SidebarMenuItem
			className={isDragging ? "opacity-50" : ""}
			draggable
			onDragEnd={() => dnd.onDragEnd()}
			onDragOver={(e) => {
				if (dnd.draggingKey) {
					e.preventDefault();
					e.dataTransfer.dropEffect = "move";
					dnd.onDragOver(chromeKey);
				}
			}}
			onDragStart={(e) => {
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData(CHROME_DND_FORMAT, chromeKey);
				// Some platforms require text/plain to start a drag.
				e.dataTransfer.setData("text/plain", chromeKey);
				dnd.onDragStart(chromeKey);
			}}
			onDrop={(e) => {
				e.preventDefault();
				dnd.onDrop(chromeKey);
			}}
		>
			{isDragOver && (
				<div
					className={`reorder-drop-indicator pointer-events-none absolute inset-x-2 z-10 h-0.5 bg-primary ${dropBelow ? "bottom-0" : "top-0"}`}
				/>
			)}
			{children}
		</SidebarMenuItem>
	);
}

function CheckedContextMenuItem({
	checked,
	children,
	icon,
	onClick,
}: {
	checked: boolean;
	children: ReactNode;
	icon?: IconSvgElement;
	onClick: () => void;
}) {
	return (
		<ContextMenuItem onClick={onClick}>
			<span className="flex size-4 shrink-0 items-center justify-center">
				{checked ? (
					<HugeiconsIcon className="size-3.5" icon={Tick02Icon} />
				) : (
					icon && <HugeiconsIcon className="size-4" icon={icon} />
				)}
			</span>
			{children}
		</ContextMenuItem>
	);
}

function SidebarContextMenuItem({
	children,
	icon,
	onClick,
}: {
	children: ReactNode;
	icon: IconSvgElement;
	onClick: () => void;
}) {
	return (
		<ContextMenuItem onClick={onClick}>
			<span className="flex size-4 shrink-0 items-center justify-center">
				<HugeiconsIcon className="size-4" icon={icon} />
			</span>
			{children}
		</ContextMenuItem>
	);
}

/** A header nav button that opens a singleton tab — with middle-click and a
 *  right-click "Open in new tab" affordance, matching the tab strip. Rendered
 *  inside a ChromeButtonShell, so it omits its own SidebarMenuItem wrapper. */
function NavTabButton({
	activeIcon,
	chromeKey,
	icon,
	label,
	menu,
	path,
}: {
	activeIcon?: IconSvgElement;
	chromeKey: ChromeKey;
	icon: IconSvgElement;
	label: string;
	menu: ChromeMenu;
	path: string;
}) {
	const { openTab, tabs, activeTabId } = useTabsContext();
	const open = (forceNew: boolean) => openTab(path, { title: label, forceNew });
	const openInNewWindow = () => {
		void openEntityInNewWindow({ path, title: label });
	};
	// Swap to the "active" glyph when the focused tab is this button's page.
	const isActive = tabs.find((t) => t.id === activeTabId)?.path === path;
	const displayIcon = isActive && activeIcon ? activeIcon : icon;
	return (
		<ContextMenu>
			<ContextMenuTrigger>
				<SidebarMenuButton
					className="h-8 rounded-md"
					onAuxClick={(e) => {
						if (e.button === 1) {
							e.preventDefault();
							open(true);
						}
					}}
					onClick={() => open(false)}
				>
					<HugeiconsIcon className="size-4" icon={displayIcon} />
					<span>{label}</span>
				</SidebarMenuButton>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onClick={() => open(true)}>
					<HugeiconsIcon className="mr-2 size-4" icon={ArrowUpRight01Icon} />
					Open in new tab
				</ContextMenuItem>
				<OpenInNewWindowContextMenuItem onClick={openInNewWindow} />
				<ContextMenuSeparator />
				<ChromeMenuItems chromeKey={chromeKey} label={label} menu={menu} />
			</ContextMenuContent>
		</ContextMenu>
	);
}

/**
 * A plugin-registered header button, rendered generically from a `sidebar_buttons`
 * contribution. First-party Ryu Apps are filtered before this renderer and use the
 * app shelf instead. Opens the contribution's `target` route; its glyph resolves
 * through the string-`icon` primitive (Iconify/Hugeicons) rather than a compiled
 * IconSvgElement. Present only while the owning app is enabled (the aggregator
 * filters the feed), so a disabled/absent app leaves no button behind.
 */
function DynamicSidebarButton({
	button,
	menu,
}: {
	button: PluginSidebarButton;
	menu: ChromeMenu;
}) {
	const { openTab } = useTabsContext();
	const chromeKey = `plugin:${button.plugin}:${button.id}` as ChromeKey;
	const open = (forceNew: boolean) =>
		openTab(button.target, {
			...(button.context ? { mountContext: button.context } : {}),
			title: button.title,
			forceNew,
		});
	const openInNewWindow = () => {
		const { path, options } = parseContributedTarget(button.target);
		void openEntityInNewWindow({
			conversationId: options.conversationId,
			path,
			title: button.title,
		});
	};
	return (
		<ContextMenu>
			<ContextMenuTrigger>
				<SidebarMenuButton
					className="h-8 rounded-md"
					onAuxClick={(e) => {
						if (e.button === 1) {
							e.preventDefault();
							open(true);
						}
					}}
					onClick={() => open(false)}
				>
					{button.icon ? (
						<Icon className="size-4" icon={button.icon} size={16} />
					) : (
						<HugeiconsIcon className="size-4" icon={Package01Icon} />
					)}
					<span>{button.title}</span>
				</SidebarMenuButton>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onClick={() => open(true)}>
					<HugeiconsIcon className="mr-2 size-4" icon={ArrowUpRight01Icon} />
					Open in new tab
				</ContextMenuItem>
				<OpenInNewWindowContextMenuItem onClick={openInNewWindow} />
				<ContextMenuSeparator />
				<ChromeMenuItems
					chromeKey={chromeKey}
					label={button.title}
					menu={menu}
				/>
			</ContextMenuContent>
		</ContextMenu>
	);
}

interface AppSidebarProps {
	activeConversationId?: string | null;
	onDeleteConversation?: (id: string) => void;
	onNewConversation?: () => void;
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
	labels: Record<SectionKey, string>;
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
						icon={SECTION_TAB_ICONS[key as BuiltinSectionKey]}
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
export function SidebarPanelContent({
	activeConversationId = null,
	onSelectConversation,
	onNewConversation,
	onDeleteConversation,
}: AppSidebarProps) {
	const productMode = useProductMode();
	const botProduct = productMode === "bot";
	const {
		listConversations,
		conversations,
		forkConversation,
		removeConversationFromProject,
		renameConversation,
		setConversationGlyph,
		setConversationVisibility,
		refresh,
		loadMessages,
	} = useChatHistoryContext();
	const { canMakePrivate } = useVisibilityAdminAccess();
	const { openTab, updateTabsIconWhere, requestScrollToMessage } =
		useTabsContext();
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
		[activeNode.url, activeNode.token]
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
	// Sessions and quietly break the one thing that mode promises (land on the
	// roster). Clearing lets each mode's own default win.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reacting to the mode change itself, not to the setter.
	useEffect(() => {
		setActiveTabbedSection(null);
	}, [sidebarMode]);

	// Pin/archive/unread live in one module-level store (see
	// `useConversationFlagsStore`) because the tab context menus offer the same
	// rows; a second `useState` copy here would desync on the first toggle.
	const unreadIds = useConversationFlagsStore((s) => s.unreadIds);
	const pinnedIds = useConversationFlagsStore((s) => s.pinnedIds);
	const archivedIds = useConversationFlagsStore((s) => s.archivedIds);
	const addUnread = useConversationFlagsStore((s) => s.addUnread);
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
				.map((s) => `plugin:${s.plugin}:${s.id}` as SectionKey),
		[contributedSections]
	);
	const resolvedSidebarMode = resolveSidebarMode(
		sidebarMode,
		sidebarModes,
		contributionsSettled
	);
	const activeMode = botProduct
		? {
				defaultSection: "chats" as SectionKey,
				description: "Ryu Bot conversations",
				key: "bot",
				layout: "stacked" as const,
				sections: ["chats"] as SectionKey[],
				title: "Ryu Bot",
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
	// chrome order the same way dynamic sections are. First-party App buttons are
	// deliberately excluded; their single entry belongs in the Apps shelf.
	const dynamicChromeKeys = useMemo<ChromeKey[]>(
		() =>
			[...contributedButtons]
				.filter((button) => !isRyuAppId(button.plugin))
				.sort(
					(a, b) =>
						(a.order ?? Number.MAX_SAFE_INTEGER) -
						(b.order ?? Number.MAX_SAFE_INTEGER)
				)
				.map((b) => `plugin:${b.plugin}:${b.id}` as ChromeKey),
		[contributedButtons]
	);
	const effectiveChromeOrder = useMemo<ChromeKey[]>(() => {
		// Drop stale app-button keys from older releases as well as currently absent
		// plugin buttons. The app shelf below is the only host-level app entry point.
		const current = chromeOrder.filter(
			(key) => !isDynamicChromeKey(key) || dynamicChromeKeys.includes(key)
		);
		const missing = dynamicChromeKeys.filter((k) => !current.includes(k));
		return missing.length > 0 ? [...current, ...missing] : current;
	}, [chromeOrder, dynamicChromeKeys]);
	const [chromeDraggingKey, setChromeDraggingKey] = useState<ChromeKey | null>(
		null
	);
	const [chromeDragOverKey, setChromeDragOverKey] = useState<ChromeKey | null>(
		null
	);
	const [sectionPageSizes, setSectionPageSizes] =
		useState<Partial<Record<SectionKey, number>>>(loadPageSizes);
	const [sectionSorts, setSectionSorts] =
		useState<Partial<Record<SectionKey, SortKey>>>(loadSorts);
	const [customizeOpen, setCustomizeOpen] = useState(false);
	const prevStatusesRef = useRef(new Map<string, string | undefined>());

	useEffect(() => {
		const newUnreads: string[] = [];
		for (const conv of conversations) {
			const prevStatus = prevStatusesRef.current.get(conv.id);
			const currStatus = conv.runStatus;
			if (
				currStatus &&
				currStatus !== prevStatus &&
				conv.id !== activeConversationId
			) {
				newUnreads.push(conv.id);
			}
			prevStatusesRef.current.set(conv.id, currStatus);
		}
		if (newUnreads.length > 0) {
			addUnread(newUnreads);
		}
	}, [conversations, activeConversationId, addUnread]);

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
	const visibleChromeOrder = chromeOrder.filter((k) => !hiddenChrome.has(k));

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
		onDrop: handleDropChrome,
	};

	const sectionMenu: SectionMenu = {
		canMove: canMoveSection,
		onMove: handleMoveSection,
		onHide: (key) => setSectionHidden(key, true),
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
		onDrop: handleDropSection,
	};

	const chatRowHandlers: ChatRowHandlers = {
		activeConversationId,
		agents,
		archivedIds,
		pinnedIds,
		unreadIds,
		loadMessages,
		onAddScheduledTask: setScheduledConversationId,
		onDeleteConversation: onDeleteConversation ?? (() => undefined),
		onForkConversation: handleForkConversation,
		onJumpToMessage: handleJumpToMessage,
		onMarkRead: markRead,
		onMarkUnread: markUnread,
		onOpenInNewTab: handleOpenConversationInNewTab,
		onOpenInNewWindow: handleOpenConversationInNewWindow,
		onOpenNewSideChat: handleOpenNewSideChat,
		onOpenSideChat: handleOpenSideChat,
		onRenameConversation: renameConversation,
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
		canMakePrivate,
		pullRequestsEnabled: pluginApps.some(
			(app) => app.id === "@ryu/pull-requests" && app.enabled
		),
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
	const sectionLabels: Record<string, string> = { ...SECTION_LABELS };
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
							className="h-8 rounded-md"
							onClick={handleNewConversation}
						>
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							<span>New chat</span>
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
						label="Library"
						menu={chromeMenu}
						path="/library"
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
						label="Customize"
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
		const ownerPluginId = SECTION_PLUGIN_OWNER[key];
		if (ownerPluginId && pluginApps.length > 0) {
			const owner = pluginApps.find((a) => a.id === ownerPluginId);
			if (!owner?.enabled) {
				return null;
			}
		}
		const sectionProps: SectionProps = {
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
				return <AppsSection key={key} {...sectionProps} />;
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
						loose={looseChats}
						managedProduct={botProduct}
						onImport={botProduct ? undefined : () => setImportOpen(true)}
						onImportSetup={
							botProduct ? undefined : () => setSetupImportOpen(true)
						}
						onNew={handleNewConversation}
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
	// declared Agents → Sessions order. `hiddenSections` is deliberately NOT
	// applied to them: picking a mode is a more specific instruction than a
	// section hidden back when the sidebar listed fifteen of them, and a two-tab
	// toggle missing one of its halves is just the previous mode with fewer rows.
	const tabbedKeys = activeMode.sections
		? orderedSidebarModeSections(activeMode, renderOrder)
		: visibleTabbedKeys;
	// Keep the active tab pointed at a real, visible section. A mode's declared
	// `defaultSection` wins over "the first tab" — Bot mode declares Agents as
	// both its first tab and its default, so the roster is the primary surface.
	const defaultTabbedKey =
		activeMode.defaultSection && tabbedKeys.includes(activeMode.defaultSection)
			? activeMode.defaultSection
			: (tabbedKeys[0] ?? null);
	const activeTabbedKey =
		activeTabbedSection && tabbedKeys.includes(activeTabbedSection)
			? activeTabbedSection
			: defaultTabbedKey;

	// In Bot mode the chat list is the "Sessions" half of the toggle — the
	// vocabulary Grok/Hermes bot mode uses, and the word that reads correctly
	// opposite "Agents". A label the user renamed in Customize wins over both.
	const stripLabels =
		activeMode.key === "agent" && sectionLabels.chats === SECTION_LABELS.chats
			? { ...sectionLabels, chats: "Sessions" }
			: sectionLabels;

	// The peek jump-list only makes sense in a stacked mode, where every visible
	// section is rendered (and thus has a scroll anchor). Under a tab strip only one
	// section exists at a time, so there's nothing to jump between.
	const sectionNavItems =
		activeMode.layout === "stacked"
			? visibleTabbedKeys.map((key) => ({
					key,
					label: sectionLabels[key] ?? key,
				}))
			: [];

	return (
		<>
			<SidebarSectionNav items={sectionNavItems} />
			<SidebarHeader className="pt-0 pb-0">
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
						    it never collides with that cluster. The build badge ("Dev" /
						    channel) sits beside the account button (see NavUser). */}
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
						labels={stripLabels}
						onSelect={setActiveTabbedSection}
					/>
				)}
			</SidebarHeader>

			{/* Right-clicking the sidebar background (not a row — each row's own
			    context menu stops propagation) opens the sidebar-wide menu. */}
			<ContextMenu>
				<ContextMenuTrigger
					render={<SidebarContent className="scroll-fade pt-2" />}
				>
					{activeMode.layout === "stacked"
						? renderOrder.map((key) => renderSection(key))
						: activeTabbedKey && renderSection(activeTabbedKey, true)}
				</ContextMenuTrigger>
				{!botProduct && (
					<ContextMenuContent>
						<ContextMenuSectionHeading>Sidebar mode</ContextMenuSectionHeading>
						{/* One row per mode on offer, built-in and contributed alike — the
					    menu has no idea which is which, which is the point. */}
						{sidebarModes.map((mode) => (
							<CheckedContextMenuItem
								checked={activeMode.key === mode.key}
								key={mode.key}
								onClick={() => setSidebarMode(mode.key as SidebarMode)}
							>
								{mode.title}
							</CheckedContextMenuItem>
						))}
						<ContextMenuSeparator />
						<ContextMenuSectionHeading>Sidebar style</ContextMenuSectionHeading>
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
						label: CHROME_LABELS[key as BuiltinChromeKey] ?? key,
					}))}
					chromeHidden={hiddenChrome}
					fixedTopChromeItems={CHROME_ORDER.filter(
						(key) => !(FOOTER_CHROME.has(key) || isHeaderButtonChrome(key))
					).map((key) => ({
						key,
						label: CHROME_LABELS[key as BuiltinChromeKey] ?? key,
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
						setChromeHidden(key as ChromeKey, !hiddenChrome.has(key))
					}
					onToggleHidden={(key) =>
						setSectionHidden(key, !hiddenSections.has(key))
					}
					open={customizeOpen}
					order={renderOrder}
					topButtonItems={effectiveChromeOrder.map((key) => ({
						key,
						label:
							CHROME_LABELS[key as BuiltinChromeKey] ??
							chromeButtonLabels[key] ??
							key,
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
		</>
	);
}

export function AppSidebar({
	activeConversationId = null,
	onSelectConversation,
	onNewConversation,
	onDeleteConversation,
}: AppSidebarProps) {
	const [sidebarVariant] = useSidebarVariant();
	return (
		<Sidebar data-sidebar-preview-boundary="" variant={sidebarVariant}>
			<SidebarPanelContent
				activeConversationId={activeConversationId}
				onDeleteConversation={onDeleteConversation}
				onNewConversation={onNewConversation}
				onSelectConversation={onSelectConversation}
			/>
			<SidebarRail />
		</Sidebar>
	);
}
