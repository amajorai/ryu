import { useMemo } from "react";
import {
	type LibraryItemType,
	type LibraryRef,
	type RecentEntry,
	refKey,
} from "@/src/lib/library.ts";
import type { LibraryItem } from "./library-sections.ts";
import type { LibraryTabsValue } from "./library-tabs.ts";
import { useLibraryPeopleItems } from "./use-library-people-items.ts";
import { useLibraryWorkItems } from "./use-library-work-items.tsx";

/** Every built-in collection, normalised into `LibraryItem`s, plus the raw lists
 *  and mutation handles the page's dialogs still need. Recents and Favorites
 *  resolve their stored refs against these lists. */
export function useLibraryCollectionItems({
	favorites,
	openTab,
	openTeam,
	recents,
}: {
	favorites: LibraryRef[];
	openTab: LibraryTabsValue["openTab"];
	openTeam: (id: string | null) => void;
	recents: RecentEntry[];
}) {
	const {
		agents,
		agentItems,
		agentsLoading,
		chatItems,
		conversations,
		conversationsLoading,
		createSpace,
		spaceItems,
		spaces,
		spacesLoading,
		workflowItems,
		workflowsLoading,
	} = useLibraryWorkItems(openTab);
	const {
		channelItems,
		channelsLoading,
		createTeam,
		identitiesLoading,
		identityItems,
		meetingItems,
		meetingsLoading,
		teamItems,
		teams,
		updateTeam,
	} = useLibraryPeopleItems({ openTab, openTeam });

	const itemsByType = useMemo<Record<LibraryItemType, LibraryItem[]>>(
		() => ({
			agent: agentItems,
			workflow: workflowItems,
			chat: chatItems,
			space: spaceItems,
			team: teamItems,
			meeting: meetingItems,
			channel: channelItems,
			identity: identityItems,
		}),
		[
			agentItems,
			workflowItems,
			chatItems,
			spaceItems,
			teamItems,
			meetingItems,
			channelItems,
			identityItems,
		]
	);

	// Flat lookup for resolving recents/favorites refs.
	const itemByKey = useMemo(() => {
		const map = new Map<string, LibraryItem>();
		for (const list of Object.values(itemsByType)) {
			for (const item of list) {
				map.set(refKey(item.type, item.id), item);
			}
		}
		return map;
	}, [itemsByType]);

	// Resolve the synthetic tabs, dropping refs whose item no longer resolves.
	const recentItems = useMemo<LibraryItem[]>(
		() =>
			recents
				.map((r) => itemByKey.get(refKey(r.type, r.id)))
				.filter((i): i is LibraryItem => i !== undefined),
		[recents, itemByKey]
	);

	const favoriteItems = useMemo<LibraryItem[]>(
		() =>
			favorites
				.map((f) => itemByKey.get(refKey(f.type, f.id)))
				.filter((i): i is LibraryItem => i !== undefined),
		[favorites, itemByKey]
	);

	const loadingByType = {
		agent: agentsLoading,
		workflow: workflowsLoading,
		// Chats are no exception to the rule every other collection follows: until
		// the list has actually come back, an empty one means "not loaded", not
		// "you have none". Hardcoding `false` here flashed the "nothing here"
		// empty state over a node that was still booting.
		chat: conversationsLoading && conversations.length === 0,
		space: spacesLoading,
		team: false,
		meeting: meetingsLoading,
		channel: channelsLoading,
		identity: identitiesLoading,
	} satisfies Record<LibraryItemType, boolean>;

	// Recents/Favorites resolve refs across every collection, so on launch (the
	// default tab is Recents) they must show a loading state while any source is
	// still loading and nothing has resolved yet — otherwise they'd flash the
	// "nothing here" empty state before the data arrives.
	const anySourceLoading =
		agentsLoading ||
		workflowsLoading ||
		spacesLoading ||
		meetingsLoading ||
		channelsLoading ||
		identitiesLoading ||
		conversationsLoading;

	return {
		agentItems,
		agents,
		agentsLoading,
		anySourceLoading,
		channelItems,
		channelsLoading,
		chatItems,
		conversations,
		conversationsLoading,
		createSpace,
		createTeam,
		favoriteItems,
		identitiesLoading,
		identityItems,
		itemsByType,
		loadingByType,
		meetingItems,
		meetingsLoading,
		recentItems,
		spaceItems,
		spaces,
		spacesLoading,
		teamItems,
		teams,
		updateTeam,
		workflowItems,
		workflowsLoading,
	};
}
