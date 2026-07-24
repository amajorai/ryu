import {
	Add01Icon,
	Archive01Icon,
	ArchiveRestoreIcon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	ArrowUpRight01Icon,
	BookOpen01Icon,
	BubbleChatIcon,
	Cancel01Icon,
	ChatAdd01Icon,
	ConnectIcon,
	CpuIcon,
	DatabaseIcon,
	Delete01Icon,
	DeliverySecure01Icon,
	Download01Icon,
	File01Icon,
	Folder01Icon,
	Folder03Icon,
	FolderOpenIcon,
	GridIcon,
	ImageAdd01Icon,
	Key01Icon,
	LibraryIcon,
	MessageQuestionIcon,
	MoreHorizontalIcon,
	Mortarboard01Icon,
	PackageIcon,
	PackageOpenIcon,
	PencilEdit01Icon,
	PinIcon,
	PinOffIcon,
	PuzzleIcon,
	Search01Icon,
	ServerStack01Icon,
	SlidersHorizontalIcon,
	Square01Icon,
	Store01Icon,
	Target01Icon,
	Tick02Icon,
	UserGroupIcon,
	ViewOffSlashIcon,
	WorkflowCircle06Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	isCoreApiPath,
	renderActionHttp,
	renderTemplate,
	type SourceItem,
	sourceItemsFromResponse,
	type ViewActionHttp,
} from "@ryu/app-host/views";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu";
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
} from "@ryu/ui/components/dropdown-menu";
import { Icon } from "@ryu/ui/components/icon";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
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
} from "@ryu/ui/components/sidebar";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	type IconComponent,
	TabsSubtle,
	TabsSubtleItem,
} from "@ryu/ui/components/tabs-subtle";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { useQuery } from "@tanstack/react-query";
import {
	type DragEvent as ReactDragEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { UsageBar } from "@/components/agent-elements/input/usage-bar.tsx";
import { ImportThreadsDialog } from "@/src/components/chat/ImportThreadsDialog.tsx";
import { NodeFolderBrowser } from "@/src/components/chat/NodeFolderBrowser.tsx";
import {
	CreateFolderDialog,
	ProjectPickerContent,
} from "@/src/components/chat/ProjectPicker.tsx";
import {
	ProjectGlyph,
	ProjectIconDialog,
} from "@/src/components/layout/ProjectIconDialog.tsx";
import { NodeSelector } from "@/src/components/shell/NodeSelector.tsx";
import { CreateSpaceDialog } from "@/src/components/spaces/CreateSpaceDialog.tsx";
import {
	TeamDialog,
	type TeamDraft,
} from "@/src/components/teams/TeamDialog.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import type { Split, Tab } from "@/src/contexts/TabsContext.tsx";
import {
	findSplit,
	splitPaneTabs,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { useAutoThreadImport } from "@/src/hooks/useAutoThreadImport.ts";
import { useChannels } from "@/src/hooks/useChannels.ts";
import { useChatDateGrouping } from "@/src/hooks/useChatDateGrouping.ts";
import {
	useComposioConnections,
	useComposioStatus,
	useComposioToolkits,
} from "@/src/hooks/useComposioCatalog.ts";
import { useEngines } from "@/src/hooks/useEngines.ts";
import { useIdentities } from "@/src/hooks/useIdentities.ts";
import { useMcp } from "@/src/hooks/useMcp.ts";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import {
	pluginCompanionPath,
	usePluginContributions,
} from "@/src/hooks/usePluginContributions.ts";
import { useSchedules } from "@/src/hooks/useSchedules.ts";
import { useSidebarMode } from "@/src/hooks/useSidebarMode.ts";
import { useSidebarVariant } from "@/src/hooks/useSidebarVariant.ts";
import { setTabLayout, useTabLayout } from "@/src/hooks/useTabLayout.ts";
import { useTeams } from "@/src/hooks/useTeams.ts";
import { useUsageBarPrefs } from "@/src/hooks/useUsageBarPrefs.ts";
import { useWorkflows } from "@/src/hooks/useWorkflows.ts";
import {
	AgentAvatar,
	AgentLogo,
	engineForAgent,
} from "@/src/lib/agent-logos.tsx";
import type { BtwEntry } from "@/src/lib/api/btw.ts";
import { listBtw } from "@/src/lib/api/btw.ts";
import { CHANNEL_LABELS } from "@/src/lib/api/channels.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { apiUrl, makeHeaders, toTarget } from "@/src/lib/api/client.ts";
import {
	setConversationArchived,
	setConversationPinned,
} from "@/src/lib/api/conversation-flags.ts";
import { synthesizeSkill } from "@/src/lib/api/learn.ts";
import type {
	PluginSidebarButton,
	PluginSidebarSection,
} from "@/src/lib/api/plugins.ts";
import { listSkills } from "@/src/lib/api/skills.ts";
import type { Space, SpaceDocument } from "@/src/lib/api/spaces.ts";
import {
	DEFAULT_HIDDEN_CHROME,
	DEFAULT_HIDDEN_SECTIONS,
	FEATURES_CHANGED_EVENT,
	loadHiddenChrome,
	loadHiddenSections,
	persistHiddenChrome,
	persistHiddenSections,
} from "@/src/lib/features.ts";
import { compactAge } from "@/src/lib/time.ts";
import {
	scheduleJobFor,
	WorkflowTriggerIcons,
} from "@/src/lib/workflow-triggers.tsx";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import type { Conversation } from "@/types/chat.ts";
import { AnnouncementsSection } from "./AnnouncementsSection.tsx";
import { CustomizeSidebarDialog } from "./CustomizeSidebarDialog.tsx";
import { NavUser } from "./NavUser.tsx";
import { OverflowTooltip } from "./overflow-tooltip.tsx";
import { SidebarSectionNav } from "./SidebarSectionNav.tsx";
import { TabGlyph } from "./TitleBar.tsx";
import { useTabDnd, useTabDragProps } from "./tabDnd.tsx";

const UNREAD_KEY = "ryu:unread-convs";
const PINNED_KEY = "ryu:pinned-convs";
const ARCHIVED_KEY = "ryu:archived-convs";
const SECTION_ORDER_KEY = "ryu:sidebar-section-order";
const SECTION_COLLAPSED_KEY = "ryu:sidebar-collapsed-sections";
// The hidden-sections set is owned by `lib/features.ts` (the single source of
// truth shared with onboarding + Settings → Features); read/write it via
// loadHiddenSections/persistHiddenSections rather than the local id-set helpers.
const SECTION_PAGE_SIZE_KEY = "ryu:sidebar-section-page-sizes";
const SECTION_SORT_KEY = "ryu:sidebar-section-sorts";
const CHROME_ORDER_KEY = "ryu:sidebar-chrome-order";

// Custom drag-data format for dragging an agent row onto a team (distinct from
// the section-reorder drag, which uses "text/plain"). The payload is the agent id.
const AGENT_DND_FORMAT = "application/x-ryu-agent";

// Sidebar sections whose backing routes are gated by a Core App (the two Core
// wraps in `require_app_enabled`: /api/meetings/* and /api/spaces/*). When that
// App is disabled the routes 503, so we hide the section rather than leave a nav
// entry that leads to a dead page. Ids mirror `apps/core/src/plugins/builtins.rs`
// (MEETINGS_PLUGIN_ID / SPACES_PLUGIN_ID).
const SECTION_PLUGIN_OWNER: Partial<Record<SectionKey, string>> = {
	// meetings/canvas/whiteboard are NOT here anymore — each is a fully app-registered
	// `sidebar_sections` contribution (com.ryu.{meetings,canvas,whiteboard}), so its
	// visibility follows the contributions feed (served only when the app is enabled),
	// not a hardcoded owner gate. Only Spaces stays a hardcoded, owner-gated section.
	spaces: "com.ryu.spaces",
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

/** The fixed, built-in sidebar sections (always present). All workspace
 *  projects/folders live nested under the single "projects" section. */
type BuiltinSectionKey =
	| "tabs"
	| "agents"
	| "teams"
	| "spaces"
	| "workflows"
	| "channels"
	| "integrations"
	| "identities"
	| "skills"
	| "mcp"
	| "tools"
	| "plugins"
	| "companions"
	| "engines"
	| "pinned"
	| "projects"
	| "chats"
	| "archived";

/** A dynamic, app-registered section key: `plugin:<pluginId>:<sectionId>`, minted
 *  from a `sidebar_sections` contribution. Namespaced so it never collides with a
 *  built-in key and is recognisable by prefix in the order/persistence machinery. */
export type DynamicSectionKey = `plugin:${string}`;

/** The reorderable top-level sidebar sections — the fixed built-ins plus any
 *  app-registered dynamic sections from the contributions feed. */
export type SectionKey = BuiltinSectionKey | DynamicSectionKey;

const DEFAULT_SECTION_ORDER: BuiltinSectionKey[] = [
	"tabs",
	"agents",
	"teams",
	"projects",
	"pinned",
	"chats",
	"spaces",
	"channels",
	"integrations",
	"plugins",
	"companions",
	"identities",
	"workflows",
	"skills",
	"mcp",
	"tools",
	"engines",
	"archived",
];

const LEGACY_DEFAULT_SECTION_ORDER: BuiltinSectionKey[] = [
	"tabs",
	"agents",
	"teams",
	"projects",
	"chats",
	"spaces",
	"channels",
	"integrations",
	"plugins",
	"identities",
	"workflows",
	"skills",
	"mcp",
	"tools",
	"engines",
	"pinned",
	"archived",
];

const PATH_SEP_RE = /[\\/]/;

/** Status-dot color class for a conversation's run status. */
function runStatusDotClass(status: string | undefined): string {
	if (status === "failed") {
		return "bg-destructive";
	}
	if (status === "running") {
		return "animate-pulse bg-primary";
	}
	return "bg-primary";
}

/** Leaf folder name from a workspace path, used as a project's label. */
function projectName(path: string): string {
	return path.split(PATH_SEP_RE).pop() ?? path;
}

/** A dynamic app-registered section key (`plugin:<pluginId>:<sectionId>`). */
function isDynamicSectionKey(value: string): value is DynamicSectionKey {
	return value.startsWith("plugin:");
}

function isSectionKey(value: string): value is SectionKey {
	// Accept dynamic `plugin:` keys too, so a persisted order keeps an app's section
	// in place across reloads (it renders nothing when that app is disabled/absent).
	return (
		isDynamicSectionKey(value) ||
		(DEFAULT_SECTION_ORDER as string[]).includes(value)
	);
}

/** Human labels for the built-in sections, shared by the customize dialog. */
const SECTION_LABELS: Record<BuiltinSectionKey, string> = {
	tabs: "Tabs",
	agents: "Agents",
	teams: "Teams",
	spaces: "Spaces",
	workflows: "Workflows",
	channels: "Channels",
	integrations: "Integrations",
	identities: "Identities",
	skills: "Skills",
	mcp: "MCP",
	tools: "Tools",
	plugins: "Plugins",
	companions: "Apps",
	engines: "Engines",
	pinned: "Pinned",
	projects: "Projects",
	chats: "Chats",
	archived: "Archived",
};

/** Glyphs for the tabbed-mode button bar (one per built-in section). */
const SECTION_ICONS: Record<BuiltinSectionKey, IconSvgElement> = {
	tabs: GridIcon,
	agents: Target01Icon,
	teams: UserGroupIcon,
	spaces: DeliverySecure01Icon,
	workflows: WorkflowCircle06Icon,
	channels: BubbleChatIcon,
	integrations: ConnectIcon,
	identities: Key01Icon,
	skills: Mortarboard01Icon,
	mcp: ServerStack01Icon,
	tools: Wrench01Icon,
	plugins: PuzzleIcon,
	companions: GridIcon,
	engines: CpuIcon,
	pinned: PinIcon,
	projects: FolderOpenIcon,
	chats: BookOpen01Icon,
	archived: Archive01Icon,
};

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
// installed, so a fresh install (quests/timeline/activity are default-OFF) showed
// buttons for features the user never had. The App declares itself; the shell does
// not enumerate Apps.
const CHROME_ORDER: ChromeKey[] = [
	"node-selector",
	// "home" removed — app-registered by com.ryu.dashboards (sidebar_buttons).
	"new-chat",
	"search",
	"library",
	// "memory" removed — now app-registered by com.ryu.memory (sidebar_buttons).
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
	// "home" removed — app-registered by com.ryu.dashboards (sidebar_buttons).
	"new-chat",
	"store",
	"library",
	// "memory" removed — app-registered by com.ryu.memory (sidebar_buttons).
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

/** Normalize a timestamp (epoch ms, ISO string, or absent) to a comparable epoch. */
function toEpoch(value: number | string | null | undefined): number {
	if (value == null) {
		return 0;
	}
	if (typeof value === "number") {
		return value;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
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

// Overflow display mode. false (default) = the classic inline "Show N more /
// Show N less" reveal; true = the "Show N more" control instead opens a
// popover to the right with a searchable, infinite-scrolled list of the whole
// section. Persisted + live-synced via usePersistedToggle, surfaced in
// Settings → Appearance.
const SIDEBAR_OVERFLOW_POPOVER_KEY = "ryu:sidebar-overflow-popover";

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
			<div className="mt-0.5 flex items-center gap-1 px-1">
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
				<div
					className="max-h-80 overflow-y-auto overscroll-contain"
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
		<div className="mt-0.5 flex items-center gap-1 px-1">
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

// The stored order can drift from the code (sections added/removed across
// versions); reconcile by keeping the stored order for known keys, dropping
// unknown ones, and splicing any section the user has never seen back into its
// default neighbourhood (so a newly-added section like Workflows lands next to
// Spaces rather than at the very bottom).
function loadSectionOrder(): SectionKey[] {
	try {
		const stored = localStorage.getItem(SECTION_ORDER_KEY);
		if (!stored) {
			return [...DEFAULT_SECTION_ORDER];
		}
		const parsed = JSON.parse(stored) as string[];
		const order = [...new Set(parsed.filter(isSectionKey))];
		if (
			order.length === LEGACY_DEFAULT_SECTION_ORDER.length &&
			order.every((key, index) => key === LEGACY_DEFAULT_SECTION_ORDER[index])
		) {
			return [...DEFAULT_SECTION_ORDER];
		}
		const missing = DEFAULT_SECTION_ORDER.filter((k) => !order.includes(k));
		for (const key of missing) {
			const defaultIdx = DEFAULT_SECTION_ORDER.indexOf(key);
			// Anchor to the nearest already-present predecessor in the default order;
			// insert right after it, or at the front when there is none.
			let insertAt = 0;
			for (let i = defaultIdx - 1; i >= 0; i--) {
				const idx = order.indexOf(DEFAULT_SECTION_ORDER[i]);
				if (idx !== -1) {
					insertAt = idx + 1;
					break;
				}
			}
			order.splice(insertAt, 0, key);
		}
		return order;
	} catch {
		return [...DEFAULT_SECTION_ORDER];
	}
}

function saveSectionOrder(order: SectionKey[]) {
	try {
		localStorage.setItem(SECTION_ORDER_KEY, JSON.stringify(order));
	} catch {
		// best-effort
	}
}

/** Shared callbacks/state threaded into every chat row, regardless of group. */
interface ChatRowHandlers {
	activeConversationId: string | null;
	archivedIds: Set<string>;
	onDeleteConversation: (id: string) => void;
	onOpenInNewTab: (id: string) => void;
	/** Open a persisted side chat: select the thread + surface it in the overlay. */
	onOpenSideChat: (conversationId: string, entry: BtwEntry) => void;
	onRenameConversation: (id: string, title: string) => void;
	onSelectConversation: (id: string) => void;
	onToggleArchive: (id: string) => void;
	onTogglePin: (id: string) => void;
	pinnedIds: Set<string>;
	/** Node target for lazily listing a conversation's side chats. */
	target: ApiTarget;
	unreadIds: Set<string>;
}

/** Lazily-loaded list of a conversation's persisted `/btw` side chats, shown
 *  indented under its row. Only mounted when the row is expanded, so collapsed
 *  rows never hit Core. Reads the node target through a ref so the fresh
 *  `toTarget()` object identity each render doesn't retrigger the fetch (see the
 *  desktop target-object deps gotcha). */
function SidebarSideChats({
	conversationId,
	target,
	onOpen,
}: {
	conversationId: string;
	onOpen: (entry: BtwEntry) => void;
	target: ApiTarget;
}) {
	const [entries, setEntries] = useState<BtwEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const targetRef = useRef(target);
	targetRef.current = target;

	useEffect(() => {
		const controller = new AbortController();
		listBtw(targetRef.current, conversationId, controller.signal)
			.then((list) => {
				if (!controller.signal.aborted) {
					setEntries(list);
				}
			})
			.catch(() => {
				/* treated as no side chats */
			})
			.finally(() => {
				if (!controller.signal.aborted) {
					setLoading(false);
				}
			});
		return () => controller.abort();
	}, [conversationId]);

	if (loading) {
		return <p className="py-1 pl-8 text-muted-foreground text-xs">Loading…</p>;
	}
	if (entries.length === 0) {
		return (
			<p className="py-1 pl-8 text-muted-foreground text-xs">No side chats</p>
		);
	}
	return (
		<SidebarMenu className="gap-0.5">
			{entries.map((entry) => (
				<SidebarMenuItem key={entry.id}>
					<button
						className="flex h-7 w-full items-center gap-2 rounded-md pr-2 pl-8 text-left transition-colors hover:bg-muted"
						onClick={() => onOpen(entry)}
						type="button"
					>
						<HugeiconsIcon
							className="size-3 shrink-0 text-muted-foreground"
							icon={MessageQuestionIcon}
						/>
						<OverflowTooltip
							className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-muted-foreground text-xs"
							fade
							text={entry.question}
						/>
					</button>
				</SidebarMenuItem>
			))}
		</SidebarMenu>
	);
}

/** A single-line chat row, Codex style: title only, actions on hover. */
function ChatRow({
	conv,
	handlers,
}: {
	conv: Conversation;
	handlers: ChatRowHandlers;
}) {
	const {
		activeConversationId,
		archivedIds,
		pinnedIds,
		unreadIds,
		onDeleteConversation,
		onOpenInNewTab,
		onOpenSideChat,
		onRenameConversation,
		onSelectConversation,
		onToggleArchive,
		onTogglePin,
		target,
	} = handlers;
	const isActive = activeConversationId === conv.id;
	const isUnread = unreadIds.has(conv.id);
	const isPinned = pinnedIds.has(conv.id);
	const isArchived = archivedIds.has(conv.id);
	const showDot = isUnread && !!conv.runStatus;

	const pinLabel = isPinned ? "Unpin" : "Pin";
	const pinIcon = isPinned ? PinOffIcon : PinIcon;
	const archiveLabel = isArchived ? "Unarchive" : "Archive";
	const archiveIcon = isArchived ? ArchiveRestoreIcon : Archive01Icon;

	// Inline rename: when `isEditing`, the title is replaced by a text input.
	// Commit on Enter / blur, cancel on Escape. Seeded from the current title.
	const [isEditing, setIsEditing] = useState(false);
	const [draftTitle, setDraftTitle] = useState(conv.title);
	const inputRef = useRef<HTMLInputElement | null>(null);

	// Side-chats disclosure: a hover-revealed chevron toggles an indented list of
	// this thread's persisted `/btw` asides (lazily fetched only while expanded).
	const [sideChatsExpanded, setSideChatsExpanded] = useState(false);

	// Deleting a chat is permanent, so both the dropdown and context-menu Delete
	// actions open a confirmation dialog rather than wiping the thread outright.
	const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

	const startEditing = () => {
		setDraftTitle(conv.title);
		setIsEditing(true);
	};
	const commitEditing = () => {
		if (!isEditing) {
			return;
		}
		setIsEditing(false);
		const next = draftTitle.trim();
		if (next && next !== conv.title) {
			onRenameConversation(conv.id, next);
		}
	};
	const cancelEditing = () => setIsEditing(false);

	useEffect(() => {
		if (isEditing) {
			inputRef.current?.focus();
			inputRef.current?.select();
		}
	}, [isEditing]);

	return (
		<SidebarMenuItem>
			<ContextMenu>
				<ContextMenuTrigger>
					{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
					<div
						className={`group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted ${isActive ? "bg-muted" : ""}`}
						onAuxClick={(e) => {
							// Middle-click opens the chat in a new tab.
							if (e.button === 1) {
								e.preventDefault();
								onOpenInNewTab(conv.id);
							}
						}}
						onClick={() => onSelectConversation(conv.id)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								onSelectConversation(conv.id);
							}
						}}
						role="button"
						tabIndex={0}
					>
						<button
							aria-label={
								sideChatsExpanded ? "Hide side chats" : "Show side chats"
							}
							className="relative flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
							onClick={(e) => {
								e.stopPropagation();
								setSideChatsExpanded((v) => !v);
							}}
							type="button"
						>
							{/* Status dot sits over the chevron slot: shown at rest, it
							    crossfades out on hover (and stays hidden while expanded) so
							    the disclosure chevron can morph in. */}
							{showDot && (
								<span
									className={`absolute inset-0 m-auto size-1.5 rounded-full transition-opacity ${
										sideChatsExpanded
											? "opacity-0"
											: "opacity-100 group-hover/row:opacity-0"
									} ${runStatusDotClass(conv.runStatus)}`}
								/>
							)}
							{/* Chevron: hidden at rest, fades in on hover; always shown (and
							    un-rotated) once expanded so it can be collapsed again. */}
							<HugeiconsIcon
								className={`size-3 transition-all ${
									sideChatsExpanded
										? "opacity-100"
										: "-rotate-90 opacity-0 group-hover/row:opacity-100"
								}`}
								icon={ArrowDown01Icon}
							/>
						</button>
						{isPinned && (
							<HugeiconsIcon
								className="size-3 shrink-0 text-muted-foreground/70"
								icon={PinIcon}
							/>
						)}
						{isEditing ? (
							<input
								className="min-w-0 flex-1 rounded-sm bg-transparent text-sm outline-none ring-1 ring-primary/40 focus:ring-primary"
								onBlur={commitEditing}
								onChange={(e) => setDraftTitle(e.target.value)}
								onClick={(e) => e.stopPropagation()}
								onKeyDown={(e) => {
									e.stopPropagation();
									if (e.key === "Enter") {
										commitEditing();
									} else if (e.key === "Escape") {
										cancelEditing();
									}
								}}
								ref={inputRef}
								value={draftTitle}
							/>
						) : (
							// Wrap the tooltip so a double-click on the title starts an
							// inline rename (OverflowTooltip doesn't forward DOM handlers).
							// biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions: double-click rename on tooltip wrapper
							<span
								className="flex min-w-0 flex-1"
								onDoubleClick={(e) => {
									e.stopPropagation();
									startEditing();
								}}
							>
								<OverflowTooltip
									className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-sm"
									fade
									text={conv.title}
								/>
							</span>
						)}
						{conv.runStatus === "running" ? (
							// A live run shows a spinner in place of the age (like ChatGPT's
							// per-chat "running" indicator) so several concurrent chats are
							// legible at a glance. Hidden on hover so the ⋯ menu can take its slot.
							<Spinner
								aria-label="Running"
								className="size-3.5 shrink-0 text-muted-foreground/70 group-hover/row:hidden"
							/>
						) : (
							<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums group-hover/row:hidden">
								{compactAge(conv.updatedAt)}
							</span>
						)}
						<DropdownMenu>
							{/* data-[popup-open] keeps the trigger visible while the menu is
							    open. Without it, moving onto the menu drops group-hover, the
							    trigger goes display:none, and Base UI loses its anchor (the menu
							    jumps to the top-left). Base UI sets data-popup-open, not
							    data-state, on the trigger. */}
							<DropdownMenuTrigger
								className="hidden h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-accent group-hover/row:inline-flex data-[popup-open]:inline-flex"
								onClick={(e) => e.stopPropagation()}
							>
								<HugeiconsIcon icon={MoreHorizontalIcon} size={12} />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										onOpenInNewTab(conv.id);
									}}
								>
									<HugeiconsIcon
										className="mr-2"
										icon={ArrowUpRight01Icon}
										size={12}
									/>
									Open in new tab
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										startEditing();
									}}
								>
									<HugeiconsIcon
										className="mr-2"
										icon={PencilEdit01Icon}
										size={12}
									/>
									Rename
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										onTogglePin(conv.id);
									}}
								>
									<HugeiconsIcon className="mr-2" icon={pinIcon} size={12} />
									{pinLabel}
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										onToggleArchive(conv.id);
									}}
								>
									<HugeiconsIcon
										className="mr-2"
										icon={archiveIcon}
										size={12}
									/>
									{archiveLabel}
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										toast.promise(synthesizeSkill(target, conv.id), {
											loading: "Making a skill from this chat…",
											success: (outcome) =>
												outcome.created
													? `Learned skill: ${outcome.slug}`
													: (outcome.reason ??
														"Nothing reusable found in this chat"),
											error: "Couldn't create a skill from this chat",
										});
									}}
								>
									<HugeiconsIcon
										className="mr-2"
										icon={Mortarboard01Icon}
										size={12}
									/>
									Make a skill from this chat
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									className="text-destructive"
									onClick={(e) => {
										e.stopPropagation();
										setConfirmDeleteOpen(true);
									}}
								>
									<HugeiconsIcon
										className="mr-2"
										icon={Delete01Icon}
										size={12}
									/>
									Delete
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem onClick={() => onOpenInNewTab(conv.id)}>
						<HugeiconsIcon className="mr-2 size-4" icon={ArrowUpRight01Icon} />
						Open in new tab
					</ContextMenuItem>
					<ContextMenuItem onClick={startEditing}>
						<HugeiconsIcon className="mr-2 size-4" icon={PencilEdit01Icon} />
						Rename
					</ContextMenuItem>
					<ContextMenuItem onClick={() => onTogglePin(conv.id)}>
						<HugeiconsIcon className="mr-2 size-4" icon={pinIcon} />
						{pinLabel}
					</ContextMenuItem>
					<ContextMenuItem onClick={() => onToggleArchive(conv.id)}>
						<HugeiconsIcon className="mr-2 size-4" icon={archiveIcon} />
						{archiveLabel}
					</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem
						className="text-destructive"
						onClick={() => setConfirmDeleteOpen(true)}
					>
						<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
						Delete
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
			{sideChatsExpanded && (
				<SidebarSideChats
					conversationId={conv.id}
					onOpen={(entry) => onOpenSideChat(conv.id, entry)}
					target={target}
				/>
			)}
			<AlertDialog onOpenChange={setConfirmDeleteOpen} open={confirmDeleteOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete this chat?</AlertDialogTitle>
						<AlertDialogDescription>
							{`"${conv.title}" will be permanently deleted. This cannot be undone.`}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => onDeleteConversation(conv.id)}
							variant="destructive"
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</SidebarMenuItem>
	);
}

/** Renders a flat list of chat rows sharing the same handler bundle. */
function ChatRowList({
	className,
	conversations,
	handlers,
}: {
	className?: string;
	conversations: Conversation[];
	handlers: ChatRowHandlers;
}) {
	return (
		<SidebarMenu className={className ?? "gap-0.5"}>
			{conversations.map((conv) => (
				<ChatRow conv={conv} handlers={handlers} key={conv.id} />
			))}
		</SidebarMenu>
	);
}

interface ProjectBucket {
	conversations: Conversation[];
	name: string;
	path: string;
}

/** Group conversations by their workspace folder (Codex-style projects). */
function groupByProject(convs: Conversation[]): {
	projects: ProjectBucket[];
	loose: Conversation[];
} {
	const projects = new Map<string, ProjectBucket>();
	const loose: Conversation[] = [];
	for (const conv of convs) {
		if (!conv.folderPath) {
			loose.push(conv);
			continue;
		}
		const existing = projects.get(conv.folderPath);
		if (existing) {
			existing.conversations.push(conv);
		} else {
			projects.set(conv.folderPath, {
				name: conv.folderPath.split(PATH_SEP_RE).pop() ?? conv.folderPath,
				path: conv.folderPath,
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
			{icon && <HugeiconsIcon className="size-3.5 shrink-0" icon={icon} />}
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
					className={`pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-primary ${dropBelow ? "bottom-0" : "top-0"}`}
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
	const activeSplit = findSplit(tabs, splits, activeTabId);
	const inActiveSplit = inSplit && tab.splitId === activeSplit?.id;
	const { isDragging, showBefore, showAfter, dragHandlers } = useTabDragProps(
		tab.id,
		"y"
	);
	const rowState = isActive ? "bg-muted" : "hover:bg-muted/60";
	const textState = isActive ? "text-foreground" : "text-muted-foreground";

	return (
		<SidebarMenuItem>
			<ContextMenu>
				<ContextMenuTrigger>
					{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
					<div
						className={`group/row relative flex h-8 cursor-pointer items-center gap-2 rounded-md pr-2 pl-2 transition-colors ${rowState} ${tab.unloaded ? "opacity-60" : ""} ${isDragging ? "opacity-40" : ""}`}
						onClick={() => activateTab(tab.id)}
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
								className="pointer-events-none absolute inset-x-1 -top-0.5 z-20 h-0.5 rounded-full bg-primary"
							/>
						)}
						{showAfter && (
							<span
								aria-hidden
								className="pointer-events-none absolute inset-x-1 -bottom-0.5 z-20 h-0.5 rounded-full bg-primary"
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
								className="absolute size-4 transition-all duration-150 group-hover/row:scale-50 group-hover/row:opacity-0"
								logoSize="16px"
								path={tab.path}
								unloaded={tab.unloaded}
							/>
							<HugeiconsIcon
								className="absolute size-3.5 scale-50 opacity-0 transition-all duration-150 group-hover/row:scale-100 group-hover/row:opacity-100"
								icon={Cancel01Icon}
							/>
						</button>
						<OverflowTooltip
							className={`min-w-0 flex-1 overflow-hidden whitespace-nowrap text-sm ${textState} ${tab.unloaded ? "italic" : ""}`}
							fade
							text={tab.title}
						/>
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
					<ContextMenuSeparator />
					<ContextMenuItem
						onClick={() => openTab(tab.path, { forceNew: true })}
					>
						<HugeiconsIcon className="mr-2 size-4" icon={ArrowUpRight01Icon} />
						Duplicate tab
					</ContextMenuItem>
					<ContextMenuItem onClick={() => setTabLayout("horizontal")}>
						Use horizontal tabs
					</ContextMenuItem>
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
	const { tabs, addTabToSplit, unsplit } = useTabsContext();
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
				<HugeiconsIcon className="size-3" icon={GridIcon} />
				<span className="font-medium text-xs">
					{canJoin && joinHover
						? "Drop to add"
						: `${label} · ${members.length}`}
				</span>
				<button
					className="ml-auto rounded px-1 text-muted-foreground text-xs hover:text-foreground"
					onClick={() => unsplit(members[0]?.id ?? "")}
					type="button"
				>
					Unsplit
				</button>
			</div>
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

/** Agents list in the sidebar — single-line rows, each with the Ryu logo. */
function AgentsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const { openTab } = useTabsContext();
	const { agents, loading } = useAgents();
	const usageBarPrefs = useUsageBarPrefs();
	const paged = usePaged(
		sortItems(agents, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const openAgent = (id: string, name: string, forceNew = false) => {
		openTab(`/agents/${id}/edit`, { title: name, forceNew });
	};

	// Start a fresh chat with this agent pre-selected (ChatPage reads initialAgent).
	const startChatWithAgent = (id: string) => {
		openTab("/chat", { forceNew: true, initialAgent: id });
	};

	const emptyMessage = loading ? "Loading…" : "No agents yet";

	const renderAgentRows = (list: typeof agents) =>
		list.map((agent) => (
			<SidebarMenuItem key={agent.id}>
				<ContextMenu>
					<ContextMenuTrigger>
						{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
						<div
							className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
							draggable
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									openAgent(agent.id, agent.name, true);
								}
							}}
							onClick={() => openAgent(agent.id, agent.name)}
							onDragStart={(e) => {
								// Drag an agent onto a team in the Teams section to add it.
								e.dataTransfer.effectAllowed = "copy";
								e.dataTransfer.setData(AGENT_DND_FORMAT, agent.id);
								// Some platforms require text/plain to start a drag.
								e.dataTransfer.setData("text/plain", agent.name);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									openAgent(agent.id, agent.name);
								}
							}}
							role="button"
							tabIndex={0}
						>
							<AgentAvatar
								avatarUrl={agent.avatarUrl}
								className="size-4 shrink-0 rounded-[3px] object-contain"
								engine={engineForAgent(agent)}
								size="16px"
							/>
							<OverflowTooltip
								className="min-w-0 shrink overflow-hidden whitespace-nowrap text-sm"
								fade
								text={agent.name}
							/>
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
											aria-label={`New chat with ${agent.name}`}
											className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
											onClick={(e) => {
												e.stopPropagation();
												startChatWithAgent(agent.id);
											}}
											type="button"
										>
											<HugeiconsIcon icon={Add01Icon} size={14} />
										</button>
									}
								/>
								<TooltipContent>New chat</TooltipContent>
							</Tooltip>
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
					</ContextMenuContent>
				</ContextMenu>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton
					onClick={() => openTab("/agents/new/edit", { title: "New agent" })}
					title="New agent"
				/>
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
			)}
		</SidebarSection>
	);
}

/** A small overlapping stack of member engine logos used as a team's glyph.
 *  Falls back to the group icon when a team has no members yet. */
function TeamLogoStack({
	members,
}: {
	members: { id: string; engine: string | null }[];
}) {
	if (members.length === 0) {
		return (
			<HugeiconsIcon
				className="size-4 shrink-0 text-muted-foreground"
				icon={UserGroupIcon}
			/>
		);
	}
	const shown = members.slice(0, 3);
	return (
		<div className="flex shrink-0 items-center">
			{shown.map((member, i) => (
				<span
					className={`flex size-4 items-center justify-center rounded-full bg-background ring-1 ring-border ${i > 0 ? "-ml-1.5" : ""}`}
					key={member.id}
					style={{ zIndex: shown.length - i }}
				>
					<AgentLogo
						className="size-2.5 object-contain"
						engine={member.engine}
						size="10px"
					/>
				</span>
			))}
		</div>
	);
}

/** Teams list in the sidebar — each team is a drop target: drag an agent row
 *  from the Agents section onto a team to add it as a member. The "+" creates a
 *  team via the shared TeamDialog; rows expand to show members, and the context
 *  menu edits the team (name + coordination strategy) or removes members. */
function TeamsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const { teams, create, update, remove, addMember, removeMember } = useTeams();
	const { agents } = useAgents();
	const paged = usePaged(
		sortItems(teams, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [dropTarget, setDropTarget] = useState<string | null>(null);
	// Deleting a team or removing a member is irreversible, so each opens a
	// confirmation dialog before the destructive call actually runs.
	const [teamToDelete, setTeamToDelete] = useState<{
		id: string;
		name: string;
	} | null>(null);
	const [memberToRemove, setMemberToRemove] = useState<{
		memberId: string;
		name: string;
		teamId: string;
	} | null>(null);

	const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
	const memberEngine = (id: string) => {
		const agent = agents.find((a) => a.id === id);
		return agent ? engineForAgent(agent) : null;
	};

	const editingTeam = teams.find((t) => t.id === editing) ?? null;

	const toggleExpanded = (id: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});

	const handleSubmit = async (draft: TeamDraft) => {
		if (editingTeam) {
			await update(editingTeam.id, draft);
		} else {
			const created = await create(draft);
			setExpanded((prev) => new Set(prev).add(created.id));
		}
	};

	const handleDropAgent = (teamId: string, e: ReactDragEvent) => {
		e.preventDefault();
		setDropTarget(null);
		const agentId = e.dataTransfer.getData(AGENT_DND_FORMAT);
		if (agentId) {
			addMember(teamId, agentId);
			setExpanded((prev) => new Set(prev).add(teamId));
		}
	};

	const renderTeamRows = (list: typeof teams) =>
		list.map((team) => (
			<SidebarMenuItem key={team.id}>
				<ContextMenu>
					<ContextMenuTrigger>
						{/* biome-ignore lint/a11y/useKeyWithClickEvents: row is a button below */}
						{/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions: team row drag target */}
						<div
							className={`group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted ${dropTarget === team.id ? "ring-1 ring-primary" : ""}`}
							onDragLeave={() => setDropTarget(null)}
							onDragOver={(e) => {
								if (e.dataTransfer.types.includes(AGENT_DND_FORMAT)) {
									e.preventDefault();
									e.dataTransfer.dropEffect = "copy";
									setDropTarget(team.id);
								}
							}}
							onDrop={(e) => handleDropAgent(team.id, e)}
						>
							<button
								className="flex min-w-0 flex-1 items-center gap-2"
								onClick={() => toggleExpanded(team.id)}
								type="button"
							>
								<TeamLogoStack
									members={team.members.map((id) => ({
										engine: memberEngine(id),
										id,
									}))}
								/>
								<OverflowTooltip
									className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-left text-sm"
									fade
									text={team.name}
								/>
								<span className="shrink-0 text-muted-foreground text-xs">
									{team.members.length}
								</span>
							</button>
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem
							onClick={() => {
								setEditing(team.id);
								setDialogOpen(true);
							}}
						>
							<HugeiconsIcon className="mr-2 size-4" icon={PencilEdit01Icon} />
							Edit team
						</ContextMenuItem>
						<ContextMenuSeparator />
						<ContextMenuItem
							onClick={() => setTeamToDelete({ id: team.id, name: team.name })}
							variant="destructive"
						>
							<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
							Delete team
						</ContextMenuItem>
					</ContextMenuContent>
				</ContextMenu>
				{expanded.has(team.id) &&
					team.members.map((memberId) => (
						<ContextMenu key={memberId}>
							<ContextMenuTrigger>
								<div className="ml-6 flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground hover:bg-muted">
									<AgentLogo
										className="size-3 shrink-0 object-contain"
										engine={memberEngine(memberId)}
										size="12px"
									/>
									<span className="min-w-0 flex-1 truncate text-xs">
										{agentName(memberId)}
									</span>
								</div>
							</ContextMenuTrigger>
							<ContextMenuContent>
								<ContextMenuItem
									onClick={() =>
										setMemberToRemove({
											memberId,
											name: agentName(memberId),
											teamId: team.id,
										})
									}
									variant="destructive"
								>
									<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
									Remove from team
								</ContextMenuItem>
							</ContextMenuContent>
						</ContextMenu>
					))}
			</SidebarMenuItem>
		));

	return (
		<>
			<SidebarSection
				action={
					<SectionAddButton
						onClick={() => {
							setEditing(null);
							setDialogOpen(true);
						}}
						title="New team"
					/>
				}
				collapsed={collapsed}
				dnd={dnd}
				label="Teams"
				menu={menu}
				onToggleCollapsed={onToggleCollapsed}
				pageSize={pageSize}
				sectionKey="teams"
				sort={sort}
			>
				{teams.length === 0 ? (
					<p className="px-2 py-2 text-muted-foreground text-xs">
						No teams yet. Click + to create one and add agents.
					</p>
				) : (
					<>
						<SidebarMenu className="gap-0.5">
							{renderTeamRows(paged.visible)}
						</SidebarMenu>
						<SectionPagingControls
							overflow={{
								getSearchText: (team) => team.name ?? "",
								items: paged.items,
								label: "teams",
								renderList: (list) => (
									<SidebarMenu className="gap-0.5">
										{renderTeamRows(list)}
									</SidebarMenu>
								),
							}}
							paged={paged}
						/>
					</>
				)}
			</SidebarSection>
			<TeamDialog
				agents={agents}
				onClose={() => setDialogOpen(false)}
				onSubmit={handleSubmit}
				open={dialogOpen}
				team={editingTeam}
			/>
			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setTeamToDelete(null);
					}
				}}
				open={teamToDelete !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete this team?</AlertDialogTitle>
						<AlertDialogDescription>
							{teamToDelete
								? `"${teamToDelete.name}" will be permanently deleted. Its agents are not deleted. This cannot be undone.`
								: ""}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (teamToDelete) {
									remove(teamToDelete.id).catch(() => undefined);
								}
							}}
							variant="destructive"
						>
							Delete team
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setMemberToRemove(null);
					}
				}}
				open={memberToRemove !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Remove from team?</AlertDialogTitle>
						<AlertDialogDescription>
							{memberToRemove
								? `"${memberToRemove.name}" will be removed from this team. The agent itself is not deleted.`
								: ""}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (memberToRemove) {
									removeMember(
										memberToRemove.teamId,
										memberToRemove.memberId
									).catch(() => undefined);
								}
							}}
							variant="destructive"
						>
							Remove
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
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

/** Spaces list in the sidebar — mirrors Agents; rows open the Spaces tab.
 *  The "+" opens the create dialog inline (shared with the Spaces page via the
 *  SpacesProvider), so a new space appears here and in the page immediately. */
/** Lazily-loaded list of a space's pages & databases, shown indented under its
 *  row (mirrors SidebarSideChats). Only mounted while the row is expanded, so
 *  collapsed rows never hit Core. Each entry opens its editor tab. */
function SidebarSpaceDocs({
	spaceId,
	listDocuments,
	onOpenDoc,
}: {
	listDocuments: (spaceId: string) => Promise<SpaceDocument[]>;
	onOpenDoc: (doc: SpaceDocument) => void;
	spaceId: string;
}) {
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

	if (loading) {
		return <p className="py-1 pl-8 text-muted-foreground text-xs">Loading…</p>;
	}
	if (docs.length === 0) {
		return (
			<p className="py-1 pl-8 text-muted-foreground text-xs">No pages yet</p>
		);
	}
	return (
		<SidebarMenu className="gap-0.5">
			{docs.map((doc) => (
				<SidebarMenuItem key={doc.id}>
					<button
						className="flex h-7 w-full items-center gap-2 rounded-md pr-2 pl-8 text-left transition-colors hover:bg-muted"
						onClick={() => onOpenDoc(doc)}
						type="button"
					>
						<HugeiconsIcon
							className="size-3 shrink-0 text-muted-foreground"
							icon={doc.kind === "database" ? DatabaseIcon : File01Icon}
						/>
						<OverflowTooltip
							className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-muted-foreground text-xs"
							fade
							text={doc.title}
						/>
					</button>
				</SidebarMenuItem>
			))}
		</SidebarMenu>
	);
}

/** A single space row. Clicking the row toggles an indented list of its pages &
 *  databases (like a project folder expands to its chats); right-click opens the
 *  space page or deletes it. */
function SpaceSidebarRow({
	space,
	appIcon,
	listDocuments,
	onOpen,
	onOpenInNewTab,
	onOpenDoc,
	onRequestDelete,
}: {
	/** Icon id registered by the space's owning app (Iconify/icons0/Hugeicons id),
	 *  resolved through the shared <Icon> primitive. Undefined for a plain
	 *  user-created space, which keeps the default glyph. */
	appIcon?: string;
	listDocuments: (spaceId: string) => Promise<SpaceDocument[]>;
	onOpen: () => void;
	onOpenDoc: (doc: SpaceDocument) => void;
	onOpenInNewTab: () => void;
	onRequestDelete: () => void;
	space: Space;
}) {
	const [expanded, setExpanded] = useState(false);
	const toggle = () => setExpanded((v) => !v);
	return (
		<SidebarMenuItem>
			<ContextMenu>
				<ContextMenuTrigger>
					{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
					<div
						className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
						onAuxClick={(e) => {
							if (e.button === 1) {
								e.preventDefault();
								onOpenInNewTab();
							}
						}}
						onClick={toggle}
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
							{appIcon ? (
								<Icon
									className={`absolute inset-0 m-auto transition-opacity ${
										expanded
											? "opacity-0"
											: "opacity-100 group-hover/row:opacity-0"
									}`}
									icon={appIcon}
									size={16}
								/>
							) : (
								<HugeiconsIcon
									className={`absolute inset-0 m-auto size-4 transition-opacity ${
										expanded
											? "opacity-0"
											: "opacity-100 group-hover/row:opacity-0"
									}`}
									icon={DeliverySecure01Icon}
								/>
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
						<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
							{space.documentCount}
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
					<ContextMenuSeparator />
					<ContextMenuItem onClick={onRequestDelete} variant="destructive">
						<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
						Delete space
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
			{expanded && (
				<SidebarSpaceDocs
					listDocuments={listDocuments}
					onOpenDoc={onOpenDoc}
					spaceId={space.id}
				/>
			)}
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
	const { spaces, loading, error, reload, create, remove, listDocuments } =
		useSpacesContext();
	const [createOpen, setCreateOpen] = useState(false);
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
	const paged = usePaged(
		sortItems(visibleSpaces, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	// Open a specific space's page (`/spaces/:id`), pre-selecting it — the Spaces
	// page no longer renders its own space list, so selection is driven from here.
	const openSpace = (space: (typeof visibleSpaces)[number], forceNew = false) =>
		openTab(`/spaces/${space.id}`, { title: space.name, forceNew });

	// Open a document inside a space directly in its editor (databases use the
	// data-grid route, pages the markdown route) — mirrors SpacesPage.openDoc.
	const openDoc = (spaceId: string, doc: SpaceDocument) => {
		const segment = doc.kind === "database" ? "db" : "doc";
		openTab(`/spaces/${spaceId}/${segment}/${doc.id}`, {
			title: doc.title || "Untitled",
		});
	};

	const confirmDelete = async () => {
		if (!pendingDelete) {
			return;
		}
		const { id, name } = pendingDelete;
		setDeleting(true);
		try {
			await remove(id);
			setPendingDelete(null);
		} catch {
			toast.error("Couldn't delete this space", {
				description: `"${name}" and its documents weren't deleted. Please try again.`,
			});
		} finally {
			setDeleting(false);
		}
	};

	const emptyMessage = loading ? "Loading…" : "No spaces yet";

	const renderSpaceRows = (list: typeof visibleSpaces) =>
		list.map((space) => (
			<SpaceSidebarRow
				appIcon={appIconBySpaceName.get(space.name.toLowerCase())}
				key={space.id}
				listDocuments={listDocuments}
				onOpen={() => openSpace(space)}
				onOpenDoc={(doc) => openDoc(space.id, doc)}
				onOpenInNewTab={() => openSpace(space, true)}
				onRequestDelete={() =>
					setPendingDelete({ id: space.id, name: space.name })
				}
				space={space}
			/>
		));

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
				{visibleSpaces.length > 0 && (
					<>
						<SidebarMenu className="gap-0.5">
							{renderSpaceRows(paged.visible)}
						</SidebarMenu>
						<SectionPagingControls
							overflow={{
								getSearchText: (space) => space.name ?? "",
								items: paged.items,
								label: "spaces",
								renderList: (list) => (
									<SidebarMenu className="gap-0.5">
										{renderSpaceRows(list)}
									</SidebarMenu>
								),
							}}
							paged={paged}
						/>
					</>
				)}
			</SidebarSection>
			<CreateSpaceDialog
				onClose={() => setCreateOpen(false)}
				onCreate={create}
				open={createOpen}
			/>
			<AlertDialog
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
					}
				}}
				open={pendingDelete !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete this space?</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingDelete
								? `"${pendingDelete.name}" and all its documents will be permanently deleted. This can't be undone.`
								: ""}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={deleting}
							onClick={(e) => {
								// Keep the dialog open while the request runs; close on success.
								e.preventDefault();
								confirmDelete().catch(() => undefined);
							}}
							variant="destructive"
						>
							{deleting ? "Deleting…" : "Delete"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

/** Workflows list in the sidebar — mirrors Agents/Spaces; rows open the
 *  Workflows canvas for that workflow, "+" starts a new one. */
function WorkflowsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const { openTab } = useTabsContext();
	const { workflows, loading } = useWorkflows();
	// Schedule jobs give the `every`-interval anchor (lastRunAt) for the next-run
	// tooltip; the list is small and shared with the schedules page.
	const { jobs } = useSchedules();
	const paged = usePaged(
		sortItems(workflows, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const openWorkflow = (id: string, name: string, forceNew = false) =>
		openTab(`/workflows/${id}`, { title: name, forceNew });

	const emptyMessage = loading ? "Loading…" : "No workflows yet";

	const renderWorkflowRows = (list: typeof workflows) =>
		list.map((wf) => (
			<SidebarMenuItem key={wf.id}>
				<ContextMenu>
					<ContextMenuTrigger>
						{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
						<div
							className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									openWorkflow(wf.id, wf.name, true);
								}
							}}
							onClick={() => openWorkflow(wf.id, wf.name)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									openWorkflow(wf.id, wf.name);
								}
							}}
							role="button"
							tabIndex={0}
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={WorkflowCircle06Icon}
							/>
							<OverflowTooltip
								className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-sm"
								fade
								text={wf.name}
							/>
							<WorkflowTriggerIcons
								className="flex shrink-0 items-center gap-1"
								job={scheduleJobFor(wf.id, jobs)}
								triggers={wf.triggers}
							/>
							<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
								{wf.nodes.length}
							</span>
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem onClick={() => openWorkflow(wf.id, wf.name, true)}>
							<HugeiconsIcon
								className="mr-2 size-4"
								icon={ArrowUpRight01Icon}
							/>
							Open in new tab
						</ContextMenuItem>
					</ContextMenuContent>
				</ContextMenu>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton
					onClick={() => openTab("/workflows/new", { title: "New workflow" })}
					title="New workflow"
				/>
			}
			collapsed={collapsed}
			dnd={dnd}
			label="Workflows"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="workflows"
			sort={sort}
		>
			{workflows.length === 0 ? (
				<p className="px-2 py-2 text-muted-foreground text-xs">
					{emptyMessage}
				</p>
			) : (
				<>
					<SidebarMenu className="gap-0.5">
						{renderWorkflowRows(paged.visible)}
					</SidebarMenu>
					<SectionPagingControls
						overflow={{
							getSearchText: (wf) => wf.name ?? "",
							items: paged.items,
							label: "workflows",
							renderList: (list) => (
								<SidebarMenu className="gap-0.5">
									{renderWorkflowRows(list)}
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

/** Channels list in the sidebar — each row is a Telegram/Slack/WhatsApp/Discord
 *  bot. Rows and the "+" open the Gateway dialog's Channels section, where bots
 *  are created and configured. Hidden by default (opt-in feature). */
function ChannelsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const { channels, loading, authed } = useChannels();
	const openGateway = useGatewayDialog((s) => s.openGateway);
	const paged = usePaged(
		sortItems(channels, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const openChannels = () => openGateway("channels");

	let emptyMessage = "No channels yet";
	if (loading) {
		emptyMessage = "Loading…";
	} else if (!authed) {
		emptyMessage = "Sign in to add channels";
	}

	const renderChannelRows = (list: typeof channels) =>
		list.map((channel) => (
			<SidebarMenuItem key={channel.id}>
				{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
				<div
					className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
					onClick={openChannels}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							openChannels();
						}
					}}
					role="button"
					tabIndex={0}
				>
					<HugeiconsIcon
						className="size-4 shrink-0 text-muted-foreground"
						icon={BubbleChatIcon}
					/>
					<OverflowTooltip
						className="min-w-0 flex-1 truncate text-sm"
						text={channel.name}
					/>
					<span className="shrink-0 text-muted-foreground/70 text-xs">
						{CHANNEL_LABELS[channel.channelType]}
					</span>
					{/* A dim dot marks a disabled bot; enabled bots show none. */}
					{!channel.enabled && (
						<span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
					)}
				</div>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={<SectionAddButton onClick={openChannels} title="Add channel" />}
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
 *  is a profile (a named grouping of per-domain connections). Rows and the "+"
 *  open the Gateway dialog's Identities section. Hidden by default. */
function IdentitiesSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const { profiles, loading, error, refetch } = useIdentities();
	const openGateway = useGatewayDialog((s) => s.openGateway);
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

	const openIdentities = () => openGateway("identities");

	const emptyMessage = loading ? "Loading…" : "No identities yet";

	const renderIdentityRows = (list: typeof rows) =>
		list.map((row) => (
			<SidebarMenuItem key={row.id}>
				{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
				<div
					className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
					onClick={openIdentities}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							openIdentities();
						}
					}}
					role="button"
					tabIndex={0}
				>
					<HugeiconsIcon
						className="size-4 shrink-0 text-muted-foreground"
						icon={Key01Icon}
					/>
					<OverflowTooltip
						className="min-w-0 flex-1 truncate text-sm"
						text={row.name}
					/>
					<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
						{row.count}
					</span>
				</div>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton onClick={openIdentities} title="Add identity" />
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
	const target: ApiTarget = { url: node.url, token: node.token ?? null };
	const skillsQuery = useQuery({
		queryKey: ["skills", "installed", target.url],
		queryFn: () => listSkills(target),
	});
	const skills = skillsQuery.data ?? [];
	const paged = usePaged(
		sortItems(skills, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const openSkills = () => openTab("/skills", { title: "Skills" });

	const emptyMessage = skillsQuery.isLoading
		? "Loading…"
		: "No skills installed";

	const renderSkillRows = (list: typeof skills) =>
		list.map((skill) => (
			<SidebarMenuItem key={skill.id}>
				{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
				<div
					className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
					onClick={openSkills}
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
						icon={Mortarboard01Icon}
					/>
					<OverflowTooltip
						className="min-w-0 flex-1 truncate text-sm"
						text={skill.name}
					/>
					{!skill.enabled && (
						<span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
					)}
				</div>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={<SectionAddButton onClick={openSkills} title="Add skill" />}
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

	const openTools = () => openTab("/tools", { title: "Tools" });

	const emptyMessage = loading ? "Loading…" : "No MCP servers";

	const renderServerRows = (list: typeof servers) =>
		list.map((server) => (
			<SidebarMenuItem key={server.name}>
				{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
				<div
					className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
					onClick={openTools}
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
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={<SectionAddButton onClick={openTools} title="Add MCP server" />}
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

	const openTools = () => openTab("/tools", { title: "Tools" });

	const emptyMessage = loading ? "Loading…" : "No tools";

	const renderToolRows = (list: typeof tools) =>
		list.map((tool) => (
			<SidebarMenuItem key={tool.id}>
				{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
				<div
					className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
					onClick={openTools}
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
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={<SectionAddButton onClick={openTools} title="Browse tools" />}
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

	const openPlugins = () => openTab("/apps", { title: "Plugins" });

	const emptyMessage = loading ? "Loading…" : "No plugins installed";

	const renderPluginRows = (list: typeof installed) =>
		list.map((app) => (
			<SidebarMenuItem key={app.id}>
				{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
				<div
					className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
					onClick={openPlugins}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							openPlugins();
						}
					}}
					role="button"
					tabIndex={0}
				>
					<HugeiconsIcon
						className="size-4 shrink-0 text-muted-foreground"
						icon={PuzzleIcon}
					/>
					<OverflowTooltip
						className="min-w-0 flex-1 truncate text-sm"
						text={app.name}
					/>
					{!app.enabled && (
						<span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
					)}
				</div>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={<SectionAddButton onClick={openPlugins} title="Add plugin" />}
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

/** Apps list in the sidebar — the full-page companion surfaces contributed by the
 *  user's ENABLED plugins (`GET /api/plugins/contributions`, already enabled-filtered
 *  server-side). Each row navigates to its `/plugin/<companion id>` route. Renders
 *  nothing when there are no companions, so no empty header appears for users whose
 *  plugins contribute no companion surface. */
function AppsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const { openTab } = useTabsContext();
	const { companions } = usePluginContributions();

	// Critical: an always-rendered empty header would appear for every user on
	// upgrade (loadSectionOrder splices missing default keys into persisted orders),
	// so bail out entirely when there is nothing to list.
	if (companions.length === 0) {
		return null;
	}

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
			<SidebarMenu className="gap-0.5">
				{companions.map((c) => {
					const label = c.label || c.name;
					const open = () =>
						openTab(pluginCompanionPath(c.id), { title: label });
					return (
						<SidebarMenuItem key={c.id}>
							{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
							<div
								className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
								onClick={open}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										open();
									}
								}}
								role="button"
								tabIndex={0}
							>
								{c.icon ? (
									<Icon
										className="size-4 shrink-0 text-muted-foreground"
										icon={c.icon}
										size={16}
									/>
								) : (
									<HugeiconsIcon
										className="size-4 shrink-0 text-muted-foreground"
										icon={GridIcon}
									/>
								)}
								<OverflowTooltip
									className="min-w-0 flex-1 truncate text-sm"
									text={label}
								/>
							</div>
						</SidebarMenuItem>
					);
				})}
			</SidebarMenu>
		</SidebarSection>
	);
}

/**
 * An app-REGISTERED sidebar section, rendered generically from a `sidebar_sections`
 * contribution (the dynamic counterpart to the hardcoded Canvas/Whiteboard/Meetings
 * sections). Its live rows come from the contribution's declared `spec.source` — a
 * Core `/api/` path the shell fetches through the authenticated node seam, mapped via
 * {@link sourceItemsFromResponse} — so nothing is hardcoded per app. Clicking a row
 * opens `spec.itemTarget` (a `{{item.<key>}}` route template) via `openTab`. Returns
 * null when empty, mirroring {@link AppsSection}, so a disabled/empty app never leaves
 * a phantom header. (Per-row actions + create-and-open land with the Canvas migration.)
 */
function DynamicSidebarSection({
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
	const [rows, setRows] = useState<SourceItem[]>([]);
	const spec = contribution.spec;
	const source = spec?.source;
	const sourcePath = source?.http.path;
	const sourceMethod = source?.http.method ?? "GET";

	// Re-fetch the section's live rows through the authenticated node seam. Reused by
	// the initial load and after a create/delete so the list reflects the new state.
	const reload = useCallback(async () => {
		if (!(source && sourcePath && isCoreApiPath(sourcePath))) {
			setRows([]);
			return;
		}
		try {
			const target = toTarget(node);
			const resp = await fetch(apiUrl(target, sourcePath), {
				method: sourceMethod,
				headers: makeHeaders(target.token),
			});
			setRows(
				resp.ok ? sourceItemsFromResponse(source, await resp.json()) : []
			);
		} catch {
			setRows([]);
		}
	}, [node, source, sourcePath, sourceMethod]);

	useEffect(() => {
		void reload();
	}, [reload]);

	const openTarget = (
		item: Record<string, unknown>,
		title: string,
		forceNew = false
	) => {
		if (spec?.itemTarget) {
			openTab(renderTemplate(spec.itemTarget, { item }, { uriEncode: true }), {
				title,
				forceNew,
			});
		}
	};

	// Run a per-row `http` action (delete/…) templated with the row, then re-fetch.
	const runAction = async (
		http: ViewActionHttp,
		item: Record<string, unknown>
	) => {
		try {
			const target = toTarget(node);
			const rendered = renderActionHttp(http, { item });
			const resp = await fetch(apiUrl(target, rendered.path), {
				method: rendered.method,
				headers: makeHeaders(target.token),
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
		}
	};

	// The "+" create-and-open: POST the create request, read the new id from the
	// response (`targetFrom`) and open it via `itemTarget`; else just re-fetch.
	const runCreate = async () => {
		if (!spec?.create) {
			return;
		}
		try {
			const target = toTarget(node);
			const rendered = renderActionHttp(spec.create.http, {});
			const resp = await fetch(apiUrl(target, rendered.path), {
				method: rendered.method,
				headers: makeHeaders(target.token),
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
		}
	};

	// A section with nothing to list AND no way to create renders nothing (mirrors
	// AppsSection) — no phantom header for a disabled/empty app.
	if (rows.length === 0 && !spec?.create) {
		return null;
	}

	const sectionKey: SectionKey = `plugin:${contribution.plugin}:${contribution.id}`;
	const itemActions = spec?.itemActions ?? [];

	return (
		<SidebarSection
			action={
				spec?.create ? (
					<SectionAddButton
						onClick={runCreate}
						title={spec.create.label ?? `New ${contribution.title}`}
					/>
				) : undefined
			}
			collapsed={collapsed}
			dnd={dnd}
			label={contribution.title}
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey={sectionKey}
			sort={sort}
		>
			<SidebarMenu className="gap-0.5">
				{rows.map((row) => {
					const title = row.item.title;
					const open = (forceNew = false) =>
						openTarget(row.raw, title, forceNew);
					return (
						<SidebarMenuItem key={row.item.id}>
							<ContextMenu>
								<ContextMenuTrigger>
									{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
									<div
										className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
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
										{contribution.icon ? (
											<Icon
												className="size-4 shrink-0 text-muted-foreground"
												icon={contribution.icon}
												size={16}
											/>
										) : null}
										<OverflowTooltip
											className="min-w-0 flex-1 truncate text-sm"
											text={title}
										/>
									</div>
								</ContextMenuTrigger>
								<ContextMenuContent>
									{spec?.itemTarget ? (
										<ContextMenuItem onClick={() => open(true)}>
											<HugeiconsIcon
												className="mr-2 size-4"
												icon={ArrowUpRight01Icon}
											/>
											Open in new tab
										</ContextMenuItem>
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
								</ContextMenuContent>
							</ContextMenu>
						</SidebarMenuItem>
					);
				})}
			</SidebarMenu>
		</SidebarSection>
	);
}

/** Engines list in the sidebar — the local inference engines installed on this
 *  node. Rows and the "+" open the Engines store page. The resident engine shows
 *  a live dot. Hidden by default. */
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
	// The list is catalog+state merged, so keep only what's actually installed
	// (plus the resident engine, which is installed by definition).
	const installed = useMemo(
		() => engines.filter((e) => e.active || e.installState === "installed"),
		[engines]
	);
	// EngineEntry's display label is `displayName`; adapt to the shared sorter's
	// `name` accessor without mutating the source rows.
	const rows = useMemo(
		() =>
			installed.map((e) => ({
				name: e.name,
				displayName: e.displayName,
				active: e.active,
			})),
		[installed]
	);
	const paged = usePaged(
		sortItems(rows, sort, {
			created: () => null,
			name: (r) => r.displayName,
			updated: () => null,
		}),
		pageSize
	);

	const openEngines = () => openTab("/engines", { title: "Engines" });

	const emptyMessage = loading ? "Loading…" : "No engines installed";

	const renderEngineRows = (list: typeof rows) =>
		list.map((engine) => (
			<SidebarMenuItem key={engine.name}>
				{/* biome-ignore lint/a11y/useSemanticElements: sidebar row combines nested controls with drag/middle-click */}
				<div
					className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
					onClick={openEngines}
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
						icon={CpuIcon}
					/>
					<OverflowTooltip
						className="min-w-0 flex-1 truncate text-sm"
						text={engine.displayName}
					/>
					{/* The resident engine gets a live dot. */}
					{engine.active && (
						<span className="size-1.5 shrink-0 rounded-full bg-primary" />
					)}
				</div>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={<SectionAddButton onClick={openEngines} title="Add engine" />}
			collapsed={collapsed}
			dnd={dnd}
			label="Engines"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="engines"
			sort={sort}
		>
			{error && installed.length === 0 && (
				<SectionLoadError
					message="Couldn't load your engines."
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
						{renderEngineRows(paged.visible)}
					</SidebarMenu>
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
			<ChatRowList conversations={paged.visible} handlers={handlers} />
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

const CHAT_BUCKET_ORDER_KEY = "ryu:sidebar-chat-bucket-order";
const CHAT_BUCKET_COLLAPSED_KEY = "ryu:sidebar-collapsed-chat-buckets";
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

/** The ChatGPT-style date buckets, in their natural (chronological) order. */
const DATE_BUCKETS: { key: string; label: string }[] = [
	{ key: "today", label: "Today" },
	{ key: "yesterday", label: "Yesterday" },
	{ key: "last-week", label: "Last week" },
	{ key: "last-month", label: "Last month" },
	{ key: "last-year", label: "Last year" },
	{ key: "older", label: "Older" },
];
const DATE_BUCKET_LABELS: Record<string, string> = Object.fromEntries(
	DATE_BUCKETS.map((b) => [b.key, b.label])
);

const DAY_MS = 86_400_000;

/** Which date bucket a timestamp falls into, relative to the start of today. */
function dateBucketKey(ts: number, startOfToday: number): string {
	if (ts >= startOfToday) {
		return "today";
	}
	if (ts >= startOfToday - DAY_MS) {
		return "yesterday";
	}
	if (ts >= startOfToday - 7 * DAY_MS) {
		return "last-week";
	}
	if (ts >= startOfToday - 30 * DAY_MS) {
		return "last-month";
	}
	if (ts >= startOfToday - 365 * DAY_MS) {
		return "last-year";
	}
	return "older";
}

interface DateBucket {
	conversations: Conversation[];
	key: string;
	label: string;
}

/** Bucket loose chats by last-activity into the non-empty date buckets, each
 *  sorted most-recent-first, returned in chronological (Today → Older) order. */
function bucketConversationsByDate(convs: Conversation[]): DateBucket[] {
	const startOfToday = new Date();
	startOfToday.setHours(0, 0, 0, 0);
	const start = startOfToday.getTime();
	const byKey = new Map<string, Conversation[]>();
	for (const conv of convs) {
		const key = dateBucketKey(toEpoch(conv.updatedAt), start);
		const existing = byKey.get(key);
		if (existing) {
			existing.push(conv);
		} else {
			byKey.set(key, [conv]);
		}
	}
	const out: DateBucket[] = [];
	for (const { key, label } of DATE_BUCKETS) {
		const bucket = byKey.get(key);
		if (bucket && bucket.length > 0) {
			bucket.sort((a, b) => toEpoch(b.updatedAt) - toEpoch(a.updatedAt));
			out.push({ conversations: bucket, key, label });
		}
	}
	return out;
}

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
function SubSection({
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
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: sub-section is the drag-and-drop reorder target; the header button carries the keyboard-reachable affordance
		// biome-ignore lint/a11y/noNoninteractiveElementInteractions: sub-section is the drag-and-drop reorder target; the header button carries the keyboard-reachable affordance
		<div
			className={`group/subsection relative ${isDragging ? "opacity-50" : ""}`}
			onDragOver={(e) => {
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
					className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary ${dropBelow ? "bottom-0" : "top-0"}`}
				/>
			)}
			{(() => {
				const headerRow = (
					<div className="relative flex items-center">
						<button
							className="group/hdr flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-md px-2 py-1 text-foreground text-xs transition-colors active:cursor-grabbing"
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
									<HugeiconsIcon className="size-3.5 shrink-0" icon={icon} />
								))}
							<span className="min-w-0 truncate">{label}</span>
							{typeof count === "number" && (
								<span
									className={`shrink-0 text-muted-foreground/60 ${action ? "transition-opacity group-hover/subsection:opacity-0" : ""}`}
								>
									{count}
								</span>
							)}
							{/* The hover action owns the right edge, so drop the collapse
							    chevron there to avoid the two overlapping. */}
							{!action && (
								<HugeiconsIcon
									className={`-ml-0.5 size-3 shrink-0 opacity-0 transition group-hover/hdr:opacity-100 ${collapsed ? "-rotate-90" : ""}`}
									icon={ArrowDown01Icon}
								/>
							)}
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

function ChatsSection({
	collapsed,
	dnd,
	handlers,
	loose,
	menu,
	onImport,
	onNew,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps & {
	handlers: ChatRowHandlers;
	loose: Conversation[];
	/** Open the "import a past agent thread" dialog (Claude Code / Codex). */
	onImport: () => void;
	onNew: () => void;
}) {
	const [groupByDate] = useChatDateGrouping();
	const paged = usePaged(sortItems(loose, sort, CONV_SORT_ACCESSORS), pageSize);
	// Hooks must run unconditionally, so compute the grouped view even when the
	// flat list is shown — it's cheap and only rendered when the setting is on.
	const dateBuckets = useMemo(
		() => (groupByDate ? bucketConversationsByDate(loose) : []),
		[groupByDate, loose]
	);
	const bucketByKey = useMemo(
		() => new Map(dateBuckets.map((b) => [b.key, b])),
		[dateBuckets]
	);
	const bucketKeys = useMemo(
		() => dateBuckets.map((b) => b.key),
		[dateBuckets]
	);
	const nested = useNestedSections(
		CHAT_BUCKET_ORDER_KEY,
		CHAT_BUCKET_COLLAPSED_KEY,
		bucketKeys,
		false
	);

	// ChatGPT-style date buckets, each its own collapsible/reorderable
	// sub-section indented under the Chats heading.
	const groupedBody = (
		<div className="ml-2 space-y-0.5">
			{nested.orderedKeys.map((key) => {
				const bucket = bucketByKey.get(key);
				if (!bucket) {
					return null;
				}
				return (
					<SubSection
						collapsed={nested.isCollapsed(key)}
						count={bucket.conversations.length}
						dnd={nested.dnd}
						key={key}
						label={DATE_BUCKET_LABELS[key] ?? bucket.label}
						onToggleCollapsed={nested.toggle}
						sectionKey={key}
						wrapHeader={(header) => (
							<DeleteAllChatsMenu
								conversationIds={bucket.conversations.map((c) => c.id)}
								groupLabel={DATE_BUCKET_LABELS[key] ?? bucket.label}
								onDelete={handlers.onDeleteConversation}
								scope="group"
							>
								{header}
							</DeleteAllChatsMenu>
						)}
					>
						<ChatRowList
							conversations={bucket.conversations}
							handlers={handlers}
						/>
					</SubSection>
				);
			})}
		</div>
	);

	const flatBody = (
		<>
			<ChatRowList conversations={paged.visible} handlers={handlers} />
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

	return (
		<SidebarSection
			action={
				<div className="mr-1 flex items-center gap-0.5">
					<SectionActionButton
						icon={Download01Icon}
						onClick={onImport}
						title="Import a past agent thread"
					/>
					<SectionActionButton
						icon={Add01Icon}
						onClick={onNew}
						title="New chat"
					/>
				</div>
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
			{loose.length === 0 ? (
				<p className="px-2 py-2 text-muted-foreground text-xs">No chats yet</p>
			) : (
				(groupByDate && groupedBody) || flatBody
			)}
		</SidebarSection>
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
	const [iconDialogOpen, setIconDialogOpen] = useState(false);
	const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
	const noun = count === 1 ? "chat" : "chats";
	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger>
					<SubSection
						action={
							<SubSectionActionButton
								icon={ChatAdd01Icon}
								onClick={() => onNewChat(bucket.path)}
								title="New chat in this folder"
							/>
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
						label={bucket.name}
						onToggleCollapsed={onToggleCollapsed}
						sectionKey={bucket.path}
					>
						{count === 0 ? (
							<p className="px-2 py-1 text-muted-foreground/70 text-xs">
								No chats
							</p>
						) : (
							<ChatRowList
								conversations={bucket.conversations}
								handlers={handlers}
							/>
						)}
					</SubSection>
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem onClick={() => onSetActive(bucket.path)}>
						<HugeiconsIcon className="mr-2 size-4" icon={FolderOpenIcon} />
						Set as active project
					</ContextMenuItem>
					<ContextMenuItem onClick={() => setIconDialogOpen(true)}>
						<HugeiconsIcon className="mr-2 size-4" icon={ImageAdd01Icon} />
						Change icon…
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
			<ProjectIconDialog
				name={bucket.name}
				onOpenChange={setIconDialogOpen}
				open={iconDialogOpen}
				path={bucket.path}
			/>
			<AlertDialog onOpenChange={setConfirmDeleteOpen} open={confirmDeleteOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{`Delete all ${count} ${noun} in ${bucket.name}?`}</AlertDialogTitle>
						<AlertDialogDescription>
							{`This permanently deletes ${count} ${noun} in the "${bucket.name}" project. The project folder itself is untouched. This cannot be undone.`}
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

/** All workspace projects nested under one section. The list is the union of the
 *  composer's recent folders and the folders of existing conversations (minus any
 *  the user removed) — the same synced store the project picker reads, so importing
 *  or removing in either surface reflects in both. Folders with no chats still show
 *  (with a "No chats" hint) rather than disappearing. */
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

	// The `+` opens the SAME dropdown as the composer's folder picker — recent
	// folders, "Open existing folder" (the node-aware NodeFolderBrowser), and
	// "Start from scratch" — by reusing ProjectPickerContent. The create/browse
	// dialogs live OUTSIDE the menu so they survive it closing on select.
	const [menuOpen, setMenuOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [browseOpen, setBrowseOpen] = useState(false);
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
					onNewChat={handleNewChatInFolder}
					onRemove={removeProject}
					onSetActive={handleSetActive}
					onToggleCollapsed={nested.toggle}
				/>
			);
		});

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
						conversationIds={projects.flatMap((p) =>
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
				) : (
					<>
						<div className="ml-2 space-y-0.5">
							{renderProjectRows(paged.visible)}
						</div>
						<SectionPagingControls
							overflow={{
								getSearchText: (path) => path,
								items: paged.items,
								label: "projects",
								renderList: (list) => (
									<div className="ml-2 space-y-0.5">
										{renderProjectRows(list)}
									</div>
								),
							}}
							paged={paged}
						/>
					</>
				)}
			</SidebarSection>
			<CreateFolderDialog onOpenChange={setCreateOpen} open={createOpen} />
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
			<ChatRowList conversations={paged.visible} handlers={handlers} />
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
					className={`pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-primary ${dropBelow ? "bottom-0" : "top-0"}`}
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

function ContextMenuSectionHeading({ children }: { children: ReactNode }) {
	return (
		<div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
			{children}
		</div>
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
				<ContextMenuSeparator />
				<ChromeMenuItems chromeKey={chromeKey} label={label} menu={menu} />
			</ContextMenuContent>
		</ContextMenu>
	);
}

/**
 * An app-REGISTERED header button, rendered generically from a `sidebar_buttons`
 * contribution — the dynamic counterpart to the hardcoded Home/Memory/Library
 * NavTabButtons. Opens the contribution's `target` route; its glyph resolves
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
		openTab(button.target, { title: button.title, forceNew });
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
						<HugeiconsIcon className="size-4" icon={GridIcon} />
					)}
					<span>{button.title}</span>
				</SidebarMenuButton>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onClick={() => open(true)}>
					<HugeiconsIcon className="mr-2 size-4" icon={ArrowUpRight01Icon} />
					Open in new tab
				</ContextMenuItem>
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
	const { listConversations, conversations, renameConversation, refresh } =
		useChatHistoryContext();
	const { openTab } = useTabsContext();
	const activeNode = useActiveNode();
	const { agents } = useAgents();
	// Plugin enabled-state, used to hide a plugin-owned section (Meetings/Spaces)
	// whose App the user disabled — its routes 503, so the nav entry would lead to
	// a dead page. `SECTION_PLUGIN_OWNER` names the two Core gates on.
	const { apps: pluginApps } = useApps();
	// The "import a past agent thread" dialog, shared by the Chats header button
	// and (when enabled) fed continuously by the background auto-importer below.
	const [importOpen, setImportOpen] = useState(false);
	const importTarget = useMemo(
		() => ({ url: activeNode.url, token: activeNode.token ?? null }),
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
	// The synced project list (shared with the composer's project picker): the
	// active folder, recent folders, and any removed-from-app folders.
	const workspaceFolder = useWorkspaceStore((s) => s.folder);
	const recentFolders = useWorkspaceStore((s) => s.recentFolders);
	const removedProjects = useWorkspaceStore((s) => s.removedProjects);
	// Drives whether the "Tabs" section renders (vertical layout) or is skipped
	// (horizontal layout, where the title-bar strip owns the tabs).
	const tabLayout = useTabLayout();
	// "sections" (default): every section stacked. "tabbed": section labels become
	// a button bar and only the selected section's list is shown below.
	const [sidebarMode, setSidebarMode] = useSidebarMode();
	const [sidebarVariant, setSidebarVariant] = useSidebarVariant();
	// Which section the tabbed bar currently reveals. Reconciled below against the
	// visible keys so it never points at a hidden/missing section.
	const [activeTabbedSection, setActiveTabbedSection] =
		useState<SectionKey | null>(null);

	const [unreadIds, setUnreadIds] = useState<Set<string>>(() =>
		loadIdSet(UNREAD_KEY)
	);
	const [pinnedIds, setPinnedIds] = useState<Set<string>>(() =>
		loadIdSet(PINNED_KEY)
	);
	const [archivedIds, setArchivedIds] = useState<Set<string>>(() =>
		loadIdSet(ARCHIVED_KEY)
	);
	const [sectionOrder, setSectionOrder] =
		useState<SectionKey[]>(loadSectionOrder);
	// App-registered sidebar sections from the contributions feed. Namespaced keys
	// (`plugin:<pluginId>:<sectionId>`) that render via DynamicSidebarSection and are
	// appended to the persisted order (see `effectiveOrder`). Empty when no enabled
	// app contributes one, so this is inert until a fixture declares a section.
	const {
		sidebar_sections: contributedSections,
		sidebar_buttons: contributedButtons,
	} = usePluginContributions();
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
	// App-registered header buttons (`sidebar_buttons`), appended to the persisted
	// chrome order the same way dynamic sections are. Empty until an enabled app
	// contributes one, so this is inert by default.
	const dynamicChromeKeys = useMemo<ChromeKey[]>(
		() =>
			[...contributedButtons]
				.sort(
					(a, b) =>
						(a.order ?? Number.MAX_SAFE_INTEGER) -
						(b.order ?? Number.MAX_SAFE_INTEGER)
				)
				.map((b) => `plugin:${b.plugin}:${b.id}` as ChromeKey),
		[contributedButtons]
	);
	const effectiveChromeOrder = useMemo<ChromeKey[]>(() => {
		const missing = dynamicChromeKeys.filter((k) => !chromeOrder.includes(k));
		return missing.length > 0 ? [...chromeOrder, ...missing] : chromeOrder;
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
			setUnreadIds((prev) => {
				const next = new Set(prev);
				for (const id of newUnreads) {
					next.add(id);
				}
				saveIdSet(UNREAD_KEY, next);
				return next;
			});
		}
	}, [conversations, activeConversationId]);

	// Merge server-backed pin/archive state (the same columns coordinator threads
	// write) into the localStorage-seeded sets. Union, not replace: existing local
	// pins are preserved (no destructive un-pin), and a conversation pinned by a
	// coordinator or another client shows up here. Going forward, toggles
	// write-through to Core so the two stay consistent.
	useEffect(() => {
		const serverPinned = conversations.filter((c) => c.pinned).map((c) => c.id);
		const serverArchived = conversations
			.filter((c) => c.archived)
			.map((c) => c.id);
		if (serverPinned.length > 0) {
			setPinnedIds((prev) => {
				if (serverPinned.every((id) => prev.has(id))) {
					return prev;
				}
				const next = new Set(prev);
				for (const id of serverPinned) {
					next.add(id);
				}
				saveIdSet(PINNED_KEY, next);
				return next;
			});
		}
		if (serverArchived.length > 0) {
			setArchivedIds((prev) => {
				if (serverArchived.every((id) => prev.has(id))) {
					return prev;
				}
				const next = new Set(prev);
				for (const id of serverArchived) {
					next.add(id);
				}
				saveIdSet(ARCHIVED_KEY, next);
				return next;
			});
		}
	}, [conversations]);

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

	const markRead = (id: string) => {
		setUnreadIds((prev) => {
			if (!prev.has(id)) {
				return prev;
			}
			const next = new Set(prev);
			next.delete(id);
			saveIdSet(UNREAD_KEY, next);
			return next;
		});
	};

	const toggleInSet = (
		setter: typeof setPinnedIds,
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

	// Pin/archive toggles update local state + localStorage immediately
	// (optimistic), then write-through to Core so the flag is server-backed and
	// shared with coordinator threads + other clients. A failed write is
	// non-fatal — the local mirror keeps the UI correct offline.
	const handleTogglePin = (id: string) => {
		const next = !pinnedIds.has(id);
		toggleInSet(setPinnedIds, PINNED_KEY, id);
		setConversationPinned(toTarget(activeNode), id, next);
	};
	const handleToggleArchive = (id: string) => {
		const next = !archivedIds.has(id);
		toggleInSet(setArchivedIds, ARCHIVED_KEY, id);
		setConversationArchived(toTarget(activeNode), id, next);
	};

	const handleToggleSection = (key: SectionKey) =>
		toggleInSet(setCollapsedSections, SECTION_COLLAPSED_KEY, key);

	const handleSelectConversation = (id: string) => {
		markRead(id);
		onSelectConversation?.(id);
		openTab("/chat", { conversationId: id });
	};

	// Open a persisted side chat from the sidebar: bring its thread into focus,
	// then hand the entry to that thread's ChatPage (it surfaces it in the btw
	// overlay). Decoupled via a window event so the sidebar never reaches into
	// chat state directly — same pattern as the run-notification click.
	const handleOpenSideChat = (conversationId: string, entry: BtwEntry) => {
		handleSelectConversation(conversationId);
		window.dispatchEvent(
			new CustomEvent("ryu:open-side-chat", {
				detail: { conversationId, entry },
			})
		);
	};

	const handleOpenConversationInNewTab = (id: string) => {
		markRead(id);
		openTab("/chat", { conversationId: id, forceNew: true });
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
	const { projects, loose } = groupByProject(rest);

	// The project list shown in the sidebar is the synced union of the composer's
	// recent folders and the folders of existing conversations (durable Core data),
	// minus any folders the user removed from the app. Folders with no chats still
	// appear (rendering a "No chats" hint). Chats whose folder was removed fall back
	// into the loose Chats section so no conversation is hidden.
	const bucketByPath = new Map(projects.map((p) => [p.path, p]));
	const removedSet = new Set(removedProjects);
	const projectPaths = [
		...new Set([
			...(workspaceFolder ? [workspaceFolder] : []),
			...recentFolders,
			...projects.map((p) => p.path),
		]),
	].filter((path) => !removedSet.has(path));
	const projectList: ProjectBucket[] = projectPaths.map(
		(path) =>
			bucketByPath.get(path) ?? {
				conversations: [],
				name: projectName(path),
				path,
			}
	);
	const looseChats: Conversation[] = [
		...loose,
		...projects
			.filter((p) => removedSet.has(p.path))
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
	const visibleSectionOrder = effectiveOrder.filter(
		(k) => !hiddenSections.has(k)
	);

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
		const next = effectiveOrder.filter((k) => k !== key);
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
		order: effectiveOrder,
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
		archivedIds,
		pinnedIds,
		unreadIds,
		onDeleteConversation: onDeleteConversation ?? (() => undefined),
		onOpenInNewTab: handleOpenConversationInNewTab,
		onOpenSideChat: handleOpenSideChat,
		onRenameConversation: renameConversation,
		onSelectConversation: handleSelectConversation,
		onToggleArchive: handleToggleArchive,
		onTogglePin: handleTogglePin,
		target: toTarget(activeNode),
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
							<HugeiconsIcon className="size-4" icon={ChatAdd01Icon} />
							<span>New chat</span>
						</SidebarMenuButton>
					</ChromeHideMenu>
				);
			// "search" now renders as an icon next to the node selector (see the
			// SidebarHeader row below), not as a header button.
			// "home" is app-registered by `com.ryu.dashboards` (the Home dashboard's
			// owning app, default-on) via a `sidebar_buttons` contribution; no hardcoded
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
			// "memory" is no longer a hardcoded button — it is app-registered by
			// `com.ryu.memory` via a `sidebar_buttons` contribution, so it appears in
			// the header ONLY when that app is enabled (default-off ⇒ absent). The key
			// stays in BuiltinChromeKey/CHROME_LABELS so a stale persisted layout is
			// filtered out gracefully rather than crashing.
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
			case "marketplace":
				return (
					<NavTabButton
						chromeKey="marketplace"
						icon={Store01Icon}
						label="Marketplace"
						menu={chromeMenu}
						path="/marketplace"
					/>
				);
			case "apps":
				return (
					<NavTabButton
						chromeKey="apps"
						icon={Square01Icon}
						label="Apps"
						menu={chromeMenu}
						path="/apps"
					/>
				);
			case "extensions":
				return (
					<NavTabButton
						chromeKey="extensions"
						icon={PuzzleIcon}
						label="Extensions"
						menu={chromeMenu}
						path="/extensions"
					/>
				);
			// Tasks/Timeline/Activity/Calendar deliberately have NO case here: they are
			// Ryu Apps, listed by `AppsSection` from the enabled-companion feed. See
			// the note above CHROME_ORDER.
			default: {
				// App-registered header button (`plugin:<pluginId>:<buttonId>`): resolve
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
		// absent (not installed — the default-off apps) or disabled hides the section,
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
			collapsed: forceExpanded ? false : collapsedSections.has(key),
			dnd: sectionDnd,
			menu: sectionMenu,
			pageSize: sectionPageSizes[key] ?? DEFAULT_PAGE_SIZE,
			sort: sectionSorts[key] ?? DEFAULT_SORT,
			onToggleCollapsed: handleToggleSection,
		};
		switch (key) {
			case "tabs":
				// The vertical tab list only exists in vertical layout; in horizontal
				// mode the title-bar strip owns the tabs, so render nothing here.
				return tabLayout === "vertical" ? (
					<TabsSection key={key} {...sectionProps} />
				) : null;
			case "agents":
				return <AgentsSection key={key} {...sectionProps} />;
			case "teams":
				return <TeamsSection key={key} {...sectionProps} />;
			case "spaces":
				return <SpacesSection key={key} {...sectionProps} />;
			// "meetings" is app-registered (com.ryu.meetings `sidebar_sections`),
			// rendered via DynamicSidebarSection — no hardcoded case.
			case "workflows":
				return <WorkflowsSection key={key} {...sectionProps} />;
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
						key={key}
						{...sectionProps}
						handlers={chatRowHandlers}
						loose={looseChats}
						onImport={() => setImportOpen(true)}
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
	const tabbedKeys = effectiveOrder.filter(
		(key) =>
			!(hiddenSections.has(key) || (key === "tabs" && tabLayout !== "vertical"))
	);
	// Keep the active tab pointed at a real, visible section (default: the first).
	const activeTabbedKey =
		activeTabbedSection && tabbedKeys.includes(activeTabbedSection)
			? activeTabbedSection
			: (tabbedKeys[0] ?? null);

	// The peek jump-list only makes sense in "sections" mode, where every visible
	// section is rendered (and thus has a scroll anchor). In tabbed mode only one
	// section exists at a time, so there's nothing to jump between.
	const sectionNavItems =
		sidebarMode === "tabbed"
			? []
			: tabbedKeys.map((key) => ({
					key,
					label: SECTION_LABELS[key as BuiltinSectionKey] ?? key,
				}));

	return (
		<>
			<SidebarSectionNav items={sectionNavItems} />
			<SidebarHeader className="pt-0 pb-0">
				{!hiddenChrome.has("node-selector") && (
					<div
						// pt-2 drops this row onto the top row's shared centerline (see
						// Layout): sidebar top pad 2 + pt-2 + h-8 centers the selector at
						// 30.72px — the tab strip's natural line (SidebarInset m-2 +
						// h-12/2), matched by the nav cluster and macOS traffic lights.
						className="flex items-center gap-2 px-2 pt-2 pb-1"
						data-tauri-drag-region
					>
						{/* The logo and the back/forward/sidebar-toggle/search cluster all
						    live pinned at the window's top-left (in Layout). The node
						    selector is right-aligned here so it never collides with that
						    cluster. The build badge ("Dev" / channel) moved down beside the
						    account button (see NavUser). */}
						<div
							className="ml-auto flex items-center gap-0.5"
							data-tauri-drag-region={false}
						>
							{!hiddenChrome.has("node-selector") && (
								<NodeSelector mode="compact-dropdown" />
							)}
						</div>
					</div>
				)}
				<SidebarMenu>
					{effectiveChromeOrder
						.filter((key) => !hiddenChrome.has(key))
						.map((key) => (
							<ChromeButtonShell chromeKey={key} dnd={chromeDnd} key={key}>
								{renderHeaderButton(key)}
							</ChromeButtonShell>
						))}
				</SidebarMenu>
				{/* In tabbed mode the section selectors sit below the header button
				    stack as a horizontal tab strip (not menu rows); the chosen
				    section's list shows in the scrollable content below. */}
				{sidebarMode === "tabbed" && (
					<TabbedSectionNav
						activeKey={activeTabbedKey}
						keys={tabbedKeys}
						labels={sectionLabels}
						onSelect={setActiveTabbedSection}
					/>
				)}
			</SidebarHeader>

			{/* Right-clicking the sidebar background (not a row — each row's own
			    context menu stops propagation) opens the sidebar-wide menu. */}
			<ContextMenu>
				<ContextMenuTrigger
					render={<SidebarContent className="scroll-fade-effect-y pt-2" />}
				>
					{sidebarMode === "tabbed"
						? activeTabbedKey && renderSection(activeTabbedKey, true)
						: effectiveOrder.map((key) => renderSection(key))}
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuSectionHeading>Sidebar mode</ContextMenuSectionHeading>
					<CheckedContextMenuItem
						checked={sidebarMode === "sections"}
						onClick={() => setSidebarMode("sections")}
					>
						Sections
					</CheckedContextMenuItem>
					<CheckedContextMenuItem
						checked={sidebarMode === "tabbed"}
						onClick={() => setSidebarMode("tabbed")}
					>
						Tabbed sidebar
					</CheckedContextMenuItem>
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
					<ContextMenuSectionHeading>Tabs</ContextMenuSectionHeading>
					<CheckedContextMenuItem
						checked={tabLayout === "horizontal"}
						onClick={() => setTabLayout("horizontal")}
					>
						Horizontal
					</CheckedContextMenuItem>
					<CheckedContextMenuItem
						checked={tabLayout === "vertical"}
						onClick={() => setTabLayout("vertical")}
					>
						Vertical
					</CheckedContextMenuItem>
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
			</ContextMenu>

			{/* Admin-authored announcements, pinned just above the account footer
			    (outside the scroll/reorder area). Self-hides when the feed is empty;
			    toggleable via the Customize dialog's "Bottom buttons" group. */}
			{!hiddenChrome.has("announcements") && <AnnouncementsSection />}

			<SidebarFooter>
				<NavUser
					hiddenChrome={hiddenChrome}
					onHideChrome={(key) => setChromeHidden(key, true)}
				/>
			</SidebarFooter>

			<CustomizeSidebarDialog
				bottomChromeItems={CHROME_ORDER.filter((key) =>
					FOOTER_CHROME.has(key)
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
				order={effectiveOrder}
				topButtonItems={effectiveChromeOrder.map((key) => ({
					key,
					label:
						CHROME_LABELS[key as BuiltinChromeKey] ??
						chromeButtonLabels[key] ??
						key,
				}))}
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
		<Sidebar variant={sidebarVariant}>
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
