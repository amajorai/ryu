// apps/desktop/src/components/layout/tab-entity-menu.tsx
//
// The ENTITY half of a tab's right-click menu.
//
// A tab menu used to offer only tab-level verbs — pin/unload/split/duplicate/
// close — which act on the strip. But a tab is also *showing* something: a chat,
// a space, an agent, a workflow. Everything you could do to that thing lived in
// the sidebar row's menu, so "pin this chat" meant leaving the tab, finding the
// row, right-clicking it. This module renders those entity verbs as a separate
// section (after a separator, matching the strip's existing grouping) in every
// tab menu — the horizontal strip's pinned + regular pills and the sidebar's
// vertical rows.
//
// Nothing app-specific is hardcoded. The built-ins are the shell's own flags
// (pin/unread/archive, which the shell owns end to end); everything else comes
// from `contributes.context_menu_items` filtered to the anchor this tab derives
// to, exactly as the sidebar chat row already consumes it. An app that declares
// `anchor: "space"` gets its row in the tab menu of every space tab with no
// change here — and disabling the app removes the row.
//
// Rows dispatch the declared capability through the owning plugin's granted host
// seam (`pluginHostInvoke`), never inline code.

import {
	Archive01Icon,
	ArchiveRestoreIcon,
	ClipboardIcon,
	Mail01Icon,
	MoreHorizontalIcon,
	PinIcon,
	PinOffIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ContextMenuItem,
	ContextMenuSeparator,
} from "@ryu/ui/components/context-menu.tsx";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useMemo } from "react";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import type { Tab } from "@/src/contexts/TabsContext.tsx";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	type PluginContextMenuItem,
	pluginHostInvoke,
} from "@/src/lib/api/plugins.ts";
import { copyChatTranscript } from "@/src/lib/copy-chat-transcript.ts";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/** What a tab is showing, in the vocabulary `context_menu_items[].anchor` uses. */
export interface TabEntity {
	anchor: string;
	id: string;
	/** Key the entity id is passed under when dispatching a contributed row. */
	idKey: string;
}

/** Path segments, empty ones dropped (`/spaces/abc/doc/x` → `["spaces","abc",…]`). */
function segments(path: string): string[] {
	return path.split("?")[0].split("/").filter(Boolean);
}

/**
 * Route shapes that carry an entity id in the path. Each entry names the leading
 * segment, where the id sits, and which anchor + payload key it maps to. Adding
 * an anchor is one row here — the rendering below is anchor-agnostic.
 *
 * Deliberately absent: `project` and `skill`. Neither has a route that encodes an
 * id in a tab path (`/skills` is a list; a project reaches a chat tab as the
 * `initialProject` seed, not as its own page), so there is nothing to anchor a
 * row to. They cost one row here the day such a route exists.
 */
const PATH_ANCHORS: Array<{
	anchor: string;
	head: string;
	idKey: string;
	/** Segment index of the id (after `head`). */
	index: number;
	/** Segment values at `index` that are NOT ids (`/agents/new/edit`). */
	reserved?: string[];
}> = [
	{ head: "spaces", index: 1, anchor: "space", idKey: "space_id" },
	{
		head: "agents",
		index: 1,
		anchor: "agent",
		idKey: "agent_id",
		reserved: ["new"],
	},
	{
		head: "workflows",
		index: 1,
		anchor: "workflow",
		idKey: "workflow_id",
		reserved: ["new", "build"],
	},
	{
		head: "channels",
		index: 1,
		anchor: "channel",
		idKey: "channel_id",
		reserved: ["new"],
	},
];

/**
 * The entity a tab is showing, or `null` for a tab that shows no single entity
 * (`/settings`, `/store`, a launchpad chat with no conversation yet). A `null`
 * entity must render NOTHING — not an empty separator.
 */
export function deriveTabEntity(tab: Tab): TabEntity | null {
	if (tab.conversationId) {
		return {
			anchor: "conversation",
			id: tab.conversationId,
			idKey: "conversation_id",
		};
	}
	const parts = segments(tab.path);
	for (const route of PATH_ANCHORS) {
		if (parts[0] !== route.head) {
			continue;
		}
		const id = parts[route.index];
		if (!id || route.reserved?.includes(id)) {
			return null;
		}
		return { anchor: route.anchor, id, idKey: route.idKey };
	}
	return null;
}

/** One rendered row: shell built-in or app contribution, same shape either way. */
export interface EntityRow {
	/** Built-in glyph. Contributed rows leave this null and set `pluginIcon`. */
	icon: IconSvgElement | null;
	id: string;
	label: string;
	onSelect: () => void;
	/** Iconify/Hugeicons glyph id from a contribution (`icon` takes precedence). */
	pluginIcon?: string;
}

/**
 * The app-contributed rows for one entity, ready to render — no shell built-ins.
 *
 * Split out of `useTabEntityRows` so a surface that is NOT a tab can offer the
 * same rows. The sidebar was the gap: its chat row rendered contributions by
 * hardcoding `anchor === "conversation"`, so an app anchoring to `space`, `agent`
 * or `workflow` had its row appear on the tab menu and nowhere else — the sidebar
 * is where those entities are actually listed. Anchoring stays data-driven here
 * rather than growing a second per-surface copy that can drift from this one.
 */
export function useContributedRowsFor(
	anchor: string,
	idKey: string
): (id: string) => EntityRow[] {
	const { context_menu_items } = usePluginContributions();
	// Filter + sort ONCE per anchor, not once per row. The sidebar calls the
	// returned factory inside a list render, and a hook cannot be called there —
	// which is the shape that pushed the chat row into hardcoding its anchor in the
	// first place.
	const items = useMemo(
		() =>
			context_menu_items
				.filter((item) => item.anchor === anchor)
				.sort(
					(a, b) =>
						(a.order ?? Number.MAX_SAFE_INTEGER) -
						(b.order ?? Number.MAX_SAFE_INTEGER)
				),
		[context_menu_items, anchor]
	);
	return useCallback(
		(id: string) =>
			items.map((item) => contributedRow(item, { anchor, id, idKey })),
		[anchor, idKey, items]
	);
}

/** One contributed row, dispatched through the owning plugin's granted host seam. */
function contributedRow(
	item: PluginContextMenuItem,
	entity: TabEntity
): EntityRow {
	return {
		id: `plugin:${item.plugin}:${item.id}`,
		label: item.label,
		icon: null,
		pluginIcon: item.icon,
		onSelect: () => {
			// The id is keyed by anchor, so a `space` row is handed `space_id`
			// rather than a `conversation_id` its capability would ignore.
			const run = () =>
				pluginHostInvoke(
					toTarget(useNodeStore.getState().getActiveNode()),
					item.plugin,
					item.capability ?? "",
					{ ...item.args, [entity.idKey]: entity.id }
				);
			const feedback = item.feedback;
			toast.promise(run(), {
				loading: feedback?.loading ?? item.label,
				success: feedback?.success ?? item.label,
				error: feedback?.error ?? `${item.label} failed`,
			});
		},
	};
}

/**
 * The entity rows for `tab`: the shell's own verbs for that anchor, then the
 * app-contributed rows for it sorted by `order`. Empty when the tab shows no
 * entity and no app contributes to its anchor.
 */
export function useTabEntityRows(tab: Tab): EntityRow[] {
	const entity = useMemo(() => deriveTabEntity(tab), [tab]);
	const { context_menu_items } = usePluginContributions();
	const { loadMessages } = useChatHistoryContext();
	const pinnedIds = useConversationFlagsStore((s) => s.pinnedIds);
	const archivedIds = useConversationFlagsStore((s) => s.archivedIds);
	const unreadIds = useConversationFlagsStore((s) => s.unreadIds);
	const togglePin = useConversationFlagsStore((s) => s.togglePin);
	const toggleArchive = useConversationFlagsStore((s) => s.toggleArchive);
	const markRead = useConversationFlagsStore((s) => s.markRead);
	const markUnread = useConversationFlagsStore((s) => s.markUnread);

	const contributed = useMemo(() => {
		if (!entity) {
			return [];
		}
		return context_menu_items
			.filter((item) => item.anchor === entity.anchor)
			.sort(
				(a, b) =>
					(a.order ?? Number.MAX_SAFE_INTEGER) -
					(b.order ?? Number.MAX_SAFE_INTEGER)
			);
	}, [context_menu_items, entity]);

	return useMemo(() => {
		if (!entity) {
			return [];
		}
		const rows: EntityRow[] = [];

		// Shell built-ins. Only conversations have flags the shell owns; the other
		// anchors are contribution-only until they grow shell-owned verbs of their
		// own. Labels say "chat", never "tab" — the tab menu already has "Pin tab"
		// right above, and two rows labelled "Pin" would be indistinguishable.
		if (entity.anchor === "conversation") {
			const id = entity.id;
			const isPinned = pinnedIds.has(id);
			const isArchived = archivedIds.has(id);
			const isUnread = unreadIds.has(id);
			rows.push(
				{
					id: "pin-chat",
					label: isPinned ? "Unpin chat" : "Pin chat",
					icon: isPinned ? PinOffIcon : PinIcon,
					onSelect: () => togglePin(id),
				},
				{
					id: "read-chat",
					label: isUnread ? "Mark as read" : "Mark as unread",
					icon: Mail01Icon,
					onSelect: () => (isUnread ? markRead(id) : markUnread(id)),
				},
				{
					id: "archive-chat",
					label: isArchived ? "Unarchive chat" : "Archive chat",
					icon: isArchived ? ArchiveRestoreIcon : Archive01Icon,
					onSelect: () => toggleArchive(id),
				},
				{
					id: "copy-transcript",
					label: "Copy transcript",
					icon: ClipboardIcon,
					onSelect: () => {
						void copyChatTranscript(() => loadMessages(id));
					},
				}
			);
		}

		for (const item of contributed) {
			rows.push(contributedRow(item, entity));
		}
		return rows;
	}, [
		archivedIds,
		contributed,
		entity,
		loadMessages,
		markRead,
		markUnread,
		pinnedIds,
		toggleArchive,
		togglePin,
		unreadIds,
	]);
}

/**
 * A row's glyph. Built-ins carry a Hugeicon straight from the icon set; a
 * contributed row carries an id string the shell's Icon primitive resolves, and
 * falls back to the neutral ⋯ glyph when the app declared none — the same
 * fallback the sidebar chat row uses for contributed rows.
 */
export function EntityRowGlyph({ row }: { row: EntityRow }) {
	if (row.icon) {
		return <HugeiconsIcon className="size-4" icon={row.icon} />;
	}
	if (row.pluginIcon) {
		return <Icon className="size-4" icon={row.pluginIcon} size={16} />;
	}
	return <HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />;
}

/**
 * The entity section of a tab context menu: a separator then one row per verb.
 * Renders `null` (not a dangling separator) when the tab has no entity and no
 * app contributes to it.
 *
 * Returns a Fragment on purpose — a wrapper element inside `ContextMenuContent`
 * breaks the menu's roving-focus keyboard navigation.
 */
export function TabEntityMenuSection({ tab }: { tab: Tab }) {
	const rows = useTabEntityRows(tab);
	if (rows.length === 0) {
		return null;
	}
	return (
		<>
			<ContextMenuSeparator />
			{rows.map((row) => (
				<ContextMenuItem key={row.id} onClick={row.onSelect}>
					<EntityRowGlyph row={row} />
					{row.label}
				</ContextMenuItem>
			))}
		</>
	);
}
