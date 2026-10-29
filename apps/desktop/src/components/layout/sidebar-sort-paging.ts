import { useMemo, useState } from "react";
import type { SpaceDocument } from "@/src/lib/api/spaces.ts";
import { conversationSearchText } from "@/src/lib/chat-pull-request-search.ts";
import { toEpoch } from "@/src/lib/sidebar/date-buckets.ts";
import { useChatPullRequestIndex } from "@/src/store/useChatPullRequestIndex.ts";
import type { Conversation } from "@/types/chat.ts";
import { useChatGrouping } from "./sidebar-chat-grouping.tsx";
import {
	type ChatSectionViews,
	chatStatusOf,
	chatStatusRank,
	parseChatSectionViews,
} from "./sidebar-chat-view.ts";
import {
	CHAT_SECTION_VIEWS_KEY,
	SECTION_SORT_KEY,
} from "./sidebar-panel-state.tsx";
import type { SectionKey } from "./sidebar-sections.ts";
import {
	parseSidebarSorts,
	type SidebarSort,
} from "./sidebar-state-contracts.ts";

// Per-section sort: how a section orders its items before pagination. "default"
// keeps the source order (already newest-first for chats), the rest re-sort by a
// shared accessor so the same option works for chats, agents, teams, spaces, and
// workflows alike (every item type exposes a name/title + created/updated stamp).
export type SortKey = SidebarSort;

export const SORT_OPTIONS: {
	chatOnly?: boolean;
	label: string;
	value: SortKey;
}[] = [
	{ label: "Default", value: "default" },
	{ label: "Last updated", value: "updated" },
	{ label: "Recently created", value: "created" },
	{ label: "Name (A-Z)", value: "name-asc" },
	{ label: "Name (Z-A)", value: "name-desc" },
	{ chatOnly: true, label: "Status (needs attention first)", value: "status" },
	{ chatOnly: true, label: "Most messages", value: "messages" },
];
export const DEFAULT_SORT: SortKey = "default";
const SORT_KEYS: ReadonlySet<string> = new Set(
	SORT_OPTIONS.map((o) => o.value)
);

export function isSortKey(value: string): value is SortKey {
	return SORT_KEYS.has(value);
}

/** Accessors so one sorter serves every item type, whatever its field names. */
export interface SortAccessors<T> {
	created: (item: T) => number | string | null | undefined;
	/** Chat-only: message total, for "Most messages". */
	messages?: (item: T) => number;
	name: (item: T) => string;
	/** Chat-only: lower is more urgent, for "Status". */
	statusRank?: (item: T) => number;
	updated: (item: T) => number | string | null | undefined;
}

/** Return a sorted copy for the chosen option (same array ref for "default"). */
export function sortItems<T>(
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
		case "status": {
			const rank = accessors.statusRank;
			if (!rank) {
				return items;
			}
			// Most urgent first; ties keep the most recently active on top.
			copy.sort(
				(a, b) =>
					rank(a) - rank(b) ||
					toEpoch(accessors.updated(b)) - toEpoch(accessors.updated(a))
			);
			break;
		}
		case "messages": {
			const messages = accessors.messages;
			if (!messages) {
				return items;
			}
			copy.sort((a, b) => messages(b) - messages(a));
			break;
		}
		default:
			break;
	}
	return copy;
}

// Two stable accessor sets cover every section: conversations key off `title`,
// while agents/teams/spaces/workflows all share `name` + created/updated stamps.
// The chat "Status" rank needs live inputs, so sections take the full chat set
// from {@link useConversationSortAccessors}.
const CONV_SORT_ACCESSORS: SortAccessors<Conversation> = {
	created: (c) => c.createdAt,
	messages: (c) => c.messageCount ?? 0,
	name: (c) => c.title,
	updated: (c) => c.updatedAt,
};

/** Chat sort accessors whose "Status" rank reads the same live inputs (unread
 *  and running sessions) as Status grouping and filtering, so a main thread with
 *  a running session sorts as Running, as it groups and filters. */
export function useConversationSortAccessors(): SortAccessors<Conversation> {
	const { classify } = useChatGrouping();
	return useMemo(
		() => ({
			...CONV_SORT_ACCESSORS,
			statusRank: (c: Conversation) =>
				chatStatusRank(chatStatusOf(c, classify)),
		}),
		[classify]
	);
}

// Date-grouping accessors, at module scope so {@link DateGroupedRows} memoizes on a
// stable identity instead of re-bucketing on every parent render.

/** A chat is dated by last activity — the same stamp its rows already show. */
export const conversationStamp = (c: Conversation) => c.updatedAt;

/** A Space page is dated by its latest edit, falling back to creation for legacy
 *  rows. For the Uploads Space, creation still equals the upload date until a file
 *  is edited, which is the useful age to show while scanning its contents. */
export const spaceDocumentStamp = (d: SpaceDocument) =>
	d.updatedAt || d.createdAt;

/** Sort Space documents by title / their latest edit. */
export const SPACE_DOC_SORT_ACCESSORS: SortAccessors<SpaceDocument> = {
	created: (d) => d.createdAt,
	name: (d) => d.title,
	updated: (d) => d.updatedAt || d.createdAt,
};

export const NAMED_SORT_ACCESSORS: SortAccessors<{
	createdAt?: number | string | null;
	name: string;
	updatedAt?: number | string | null;
}> = {
	created: (item) => item.createdAt,
	name: (item) => item.name,
	updated: (item) => item.updatedAt,
};

export function loadSorts() {
	try {
		const stored = localStorage.getItem(SECTION_SORT_KEY);
		return parseSidebarSorts(stored ? JSON.parse(stored) : null);
	} catch {
		return parseSidebarSorts(null);
	}
}

export function loadChatSectionViews(): ChatSectionViews {
	try {
		const stored = localStorage.getItem(CHAT_SECTION_VIEWS_KEY);
		return parseChatSectionViews(stored ? JSON.parse(stored) : null);
	} catch {
		return {};
	}
}

export function saveChatSectionViews(views: ChatSectionViews) {
	try {
		localStorage.setItem(CHAT_SECTION_VIEWS_KEY, JSON.stringify(views));
	} catch {
		// best-effort
	}
}

/** Sections whose rows are chats, and so offer Group by / Filter. */
export const CHAT_VIEW_SECTIONS: ReadonlySet<SectionKey> = new Set<SectionKey>([
	"archived",
	"chats",
	"pinned",
	"projects",
]);

export function saveSorts(sorts: Partial<Record<SectionKey, SortKey>>) {
	try {
		localStorage.setItem(SECTION_SORT_KEY, JSON.stringify(sorts));
	} catch {
		// best-effort
	}
}

/** Limit a list to `pageSize` items (0 = all) with an incremental reveal. */
export function usePaged<T>(items: T[], pageSize: number) {
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

/** Chat overflow search text: the title plus the chat's pull request numbers,
 * so `#123` finds the chat tracking pull request 123. */
export function chatSearchText(conversation: Conversation): string {
	return conversationSearchText(
		conversation,
		useChatPullRequestIndex.getState().branchPullRequests
	);
}
