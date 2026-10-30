// The Library page's section model: its tabs, the app that owns each built-in
// collection, the per-type display metadata, and the one `LibraryItem` shape every
// collection is normalised into.

import {
	AudioWave01Icon,
	Clock01Icon,
	DeliverySecure01Icon,
	Image01Icon,
	StarIcon,
	Target01Icon,
	UserMultiple02Icon,
	WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { LibrarySortOption } from "@ryu/blocks/desktop/library.tsx";
import type { LibraryViewMode } from "@ryu/blocks/desktop/view-toggle.tsx";
import type { StatusKind } from "@ryu/ui/components/status-badge.tsx";
import type { ReactNode } from "react";
import {
	BUILTIN_SECTIONS,
	type BuiltinSectionKey,
	SECTION_ICONS,
	SURFACE_PLUGIN_OWNER,
} from "@/src/components/layout/sidebar-sections.ts";
import type { ChannelLiveState } from "@/src/lib/api/channelStatus.ts";
import type { PluginSidebarSection } from "@/src/lib/api/plugins.ts";
import type { LibraryItemType } from "@/src/lib/library.ts";

/** A Library tab.
 *
 *  Most tabs are collections of `LibraryItem`s rendered by the shared card/grid
 *  machinery. `"tools"` is not: the MCP servers on the node and the tools they
 *  advertise have their own hierarchy (a tool belongs to a server) and their own
 *  actions (test-call a tool), so it renders a bespoke surface inside the Library
 *  shell — the same escape hatch `"memory"` already uses. */
export type SidebarOnlySection = Exclude<
	BuiltinSectionKey,
	"agents" | "teams" | "chats" | "spaces" | "channels" | "identities"
>;

export const LIBRARY_ITEM_TYPE_BY_BUILTIN_KEY = new Map<
	BuiltinSectionKey,
	LibraryItemType
>([
	["agents", "agent"],
	["chats", "chat"],
	["channels", "channel"],
	["identities", "identity"],
	["spaces", "space"],
]);

export function isSidebarOnlySectionKey(
	key: BuiltinSectionKey
): key is SidebarOnlySection {
	return LIBRARY_ITEM_TYPE_BY_BUILTIN_KEY.get(key) === undefined;
}

export type BuiltinSection = (typeof BUILTIN_SECTIONS)[number];
export function isSidebarOnlySection(
	section: BuiltinSection
): section is BuiltinSection & { key: SidebarOnlySection } {
	return isSidebarOnlySectionKey(section.key);
}

export const SIDEBAR_LIBRARY_SECTIONS =
	BUILTIN_SECTIONS.filter(isSidebarOnlySection);

export type LibrarySection =
	| "recents"
	| "favorites"
	| "wallpapers"
	| "tools"
	| LibraryItemType
	| SidebarOnlySection;

/** Collections whose existing cards carry a richer, playful presentation. */
export const LIBRARY_SHOWCASE_SECTIONS: ReadonlySet<LibrarySection> = new Set([
	"agent",
	"space",
	"skills",
	"workflow",
]);

export const LIBRARY_VIEW_MODES: readonly LibraryViewMode[] = [
	"grid",
	"list",
	"showcase",
	"graph",
];

export function defaultLibraryView(section: LibrarySection): LibraryViewMode {
	return LIBRARY_SHOWCASE_SECTIONS.has(section) ? "showcase" : "grid";
}

/** Sections that render their OWN surface instead of the shared card grid, and so
 *  bypass the collection pipeline (normalise → filter → sort → cards). They keep
 *  the section nav so switching tabs still works. */
export const CUSTOM_SURFACE_SECTIONS = new Set<LibrarySection>([
	"tools",
	"wallpapers",
]);

export const SIDEBAR_SURFACE_SECTIONS = new Set<SidebarOnlySection>(
	SIDEBAR_LIBRARY_SECTIONS.map((section) => section.key)
);

export const SECTIONS: {
	value: LibrarySection;
	label: string;
	icon: IconSvgElement;
}[] = [
	{ value: "recents", label: "Recents", icon: Clock01Icon },
	{ value: "favorites", label: "Favorites", icon: StarIcon },
	{ value: "wallpapers", label: "Wallpapers", icon: Image01Icon },
	...BUILTIN_SECTIONS.map((section) => ({
		icon: section.icon,
		label: section.label,
		// SAFETY: The checked complete BUILTIN_SECTIONS keys split into the five authored collection mappings and the remaining SidebarOnlySection keys; this nullish fallback selects only that remainder.
		value:
			LIBRARY_ITEM_TYPE_BY_BUILTIN_KEY.get(section.key) ??
			(section.key as SidebarOnlySection),
	})),
	// Meetings are a Library collection but intentionally are not a fixed sidebar
	// section: the Meetings app contributes its own dynamic sidebar section. Keep
	// the existing built-in collection available until that app is the source of
	// truth, while still letting a source-backed contribution replace it above.
	{ value: "meeting", label: "Meetings", icon: AudioWave01Icon },
];

/** The app that owns each built-in collection. A tab shows only when its owning
 *  app is enabled — so an uninstalled Workflows/Teams/Meetings app leaves no empty
 *  tab. Sections absent here (recents/favorites/chat/channel/identity) are host
 *  surfaces, always shown.
 *
 *  The plugin ids come from `SURFACE_PLUGIN_OWNER` — the ONE table naming which
 *  app owns each compiled-in surface, shared with the sidebar. This map only says
 *  which library TYPE maps onto which surface. */
export const SECTION_PLUGIN = new Map<LibrarySection, string>([
	["agent", SURFACE_PLUGIN_OWNER.agents],
	["workflow", SURFACE_PLUGIN_OWNER.workflows],
	["space", SURFACE_PLUGIN_OWNER.spaces],
	["team", SURFACE_PLUGIN_OWNER.teams],
	["meeting", SURFACE_PLUGIN_OWNER.meetings],
]);

/** Per-type display metadata for the synthetic (mixed) tabs and filter chips. */
export const TYPE_META = {
	agent: { label: "Agent", icon: Target01Icon },
	workflow: { label: "Workflow", icon: WorkflowCircle06Icon },
	chat: { label: "Chat", icon: SECTION_ICONS.chats },
	space: { label: "Space", icon: DeliverySecure01Icon },
	team: { label: "Group", icon: UserMultiple02Icon },
	meeting: { label: "Meeting", icon: AudioWave01Icon },
	channel: { label: "Channel", icon: SECTION_ICONS.channels },
	identity: { label: "Identity", icon: SECTION_ICONS.identities },
} satisfies Record<LibraryItemType, { label: string; icon: IconSvgElement }>;

// SAFETY: TYPE_META is the local authored object checked against every LibraryItemType and is never mutated; native Object.keys returns exactly its own enumerable string keys but declares them as string[].
export const LIBRARY_ITEM_TYPES = Object.keys(TYPE_META) as LibraryItemType[];

export const SORT_OPTIONS: LibrarySortOption[] = [
	{ value: "updated", label: "Recently updated" },
	{ value: "name-asc", label: "Name A–Z" },
	{ value: "name-desc", label: "Name Z–A" },
];

/** Preserve explicit refusals while ignoring mutation response payloads. */
export function mutationResult<TResult>(result: TResult): boolean | undefined {
	return result === false ? false : undefined;
}

/** A collection item normalised from its data hook into one shared shape. */
export interface LibraryItem {
	/** Type-specific chip for typed tabs — a KIND or a type-specific label. On the
	 *  mixed tabs the item's TYPE takes this slot instead. */
	badge: string | null;
	icon: IconSvgElement;
	id: string;
	name: string;
	open: () => void;
	/** The same destination forced into a NEW tab, for the card's right-click
	 *  menu. Absent for the types that open a dialog rather than a route (teams),
	 *  where "in a new tab" has no meaning. */
	openInNewTab?: () => void;
	/** Optional richer card-body preview (grid view only). Local, cheap nodes
	 * only — anything that fetches must be gated per-tab in `toCardData`. */
	preview?: ReactNode;
	/** Delete this item. Every collection's hook exposes one, so this is set for
	 *  all of them; a per-ITEM refusal travels in `removeBlockedReason`. */
	remove?: () => Promise<boolean | undefined> | boolean | undefined;
	/** Why THIS item can't be deleted (a Ryu-owned system Space). */
	removeBlockedReason?: string;
	/** Persist a new name. Absent for the types whose hook exposes no rename —
	 *  the menu then omits the row rather than offering a dead one. */
	rename?: (
		title: string
	) => Promise<boolean | undefined> | boolean | undefined;
	/** The item's STATUS attribute, if it has one. A separate slot from `badge`
	 *  because the mixed tabs claim that one for the type label, and an agent can
	 *  be both an "Agent" and "Built-in". */
	status?: StatusKind | null;
	subtitle: string | null;
	type: LibraryItemType;
	/** Normalised epoch-ms, for "Recently updated" sort. */
	updatedAt: number;
}

/** A channel bot's live state as the row's status glyph: connected reads as
 *  Active, a failed or dropped connection as Unavailable, anything still settling
 *  (connecting / unknown / not yet reported) shows no glyph. */
export function channelStatusKind(
	state: ChannelLiveState | undefined
): StatusKind | null {
	if (state === "online") {
		return "active";
	}
	if (state === "error" || state === "offline") {
		return "unavailable";
	}
	return null;
}

export function isLibrarySection(value: string): value is LibrarySection {
	return SECTIONS.some((s) => s.value === value);
}

/** The tab key of an app-registered collection, namespaced exactly like the
 *  sidebar's dynamic section keys so the two can never collide with a built-in. */
export function contributedSectionValue(section: PluginSidebarSection): string {
	return `plugin:${section.plugin}:${section.id}`;
}

/** The active tab: one of the shell's own collections, or an app-registered one
 *  (`plugin:<pluginId>:<sectionId>`). Deliberately open — the Library's tab list
 *  is no longer a closed union the shell can enumerate at compile time. */
export type ActiveSection = LibrarySection | string;

/** True for the sections that ARE a `LibraryItemType` — i.e. the ones backed by the
 *  shared collection pipeline. Excludes the synthetic mixed tabs and any
 *  custom-surface section (which has no `LibraryItem` representation at all, so it
 *  must never be offered as a type filter chip). */
export function isItemType(value: LibrarySection): value is LibraryItemType {
	return (
		value === "agent" ||
		value === "workflow" ||
		value === "chat" ||
		value === "space" ||
		value === "team" ||
		value === "meeting" ||
		value === "channel" ||
		value === "identity"
	);
}
