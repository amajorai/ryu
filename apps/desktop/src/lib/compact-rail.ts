// apps/desktop/src/lib/compact-rail.ts
//
// The compact rail is what the left navigation collapses to at narrow widths: a
// single column of agent avatars, the way a messaging app keeps its contacts
// one tap away when there is no room for a full list. These are its pure rules —
// when it shows, how the roster is grouped, and which agent the active tab is
// talking to — kept out of the component so they can be tested on their own.

/** localStorage key for the user's "use the compact rail" preference. */
export const COMPACT_RAIL_PREFERENCE_KEY = "ryu:compact-rail";

/** The merged per-agent chat view (`/chat/agent/<id>`), which the rail opens. */
const AGENT_CHAT_PATH_RE = /^\/chat\/agent\/([^/?#]+)/;

export interface CompactRailState {
	/** The user has not turned the rail off. */
	enabled: boolean;
	/** The window cannot host a detached-tab or extension rail. */
	excluded: boolean;
	/** The viewport is below the compact breakpoint. */
	narrow: boolean;
	/** The full navigation (docked sidebar, Sheet, or moved pane) is showing. */
	navigationShown: boolean;
}

/** The rail replaces collapsed navigation only, and only at narrow widths: once
 *  the full sidebar is open it carries the same roster, and at wide widths a
 *  collapsed sidebar keeps meaning "give me the whole window". */
export function isCompactRailActive({
	enabled,
	excluded,
	narrow,
	navigationShown,
}: CompactRailState): boolean {
	return enabled && narrow && !(excluded || navigationShown);
}

/**
 * Split the roster into the pinned shelf and everyone else.
 *
 * Pinned agents keep the order they were pinned in, the same order Bot mode's
 * pinned stage shows them; the rest keep the roster's own order.
 */
export function railAgentGroups<T extends { id: string }>(
	agents: readonly T[],
	pinnedIds: readonly string[]
): { others: T[]; pinned: T[] } {
	const byId = new Map(agents.map((agent) => [agent.id, agent]));
	const pinned = [...new Set(pinnedIds)]
		.map((id) => byId.get(id))
		.filter((agent): agent is T => agent !== undefined);
	const pinnedSet = new Set(pinned.map((agent) => agent.id));
	return {
		pinned,
		others: agents.filter((agent) => !pinnedSet.has(agent.id)),
	};
}

interface RailTab {
	conversationId?: string;
	initialAgent?: string;
	path: string;
}

interface RailConversation {
	agentId?: string;
	id: string;
}

/**
 * The agent the active tab is talking to, so the rail can mark it.
 *
 * The merged agent view names its agent in the path; a bound chat names it
 * through its conversation; a fresh chat started from an agent carries it as
 * `initialAgent` until its first send binds a conversation.
 */
export function activeRailAgentId(
	tab: RailTab | undefined,
	conversations: readonly RailConversation[]
): string | null {
	if (!tab) {
		return null;
	}
	const match = AGENT_CHAT_PATH_RE.exec(tab.path);
	if (match) {
		try {
			return decodeURIComponent(match[1]);
		} catch {
			return match[1];
		}
	}
	if (tab.conversationId) {
		const conversation = conversations.find(
			(item) => item.id === tab.conversationId
		);
		if (conversation?.agentId) {
			return conversation.agentId;
		}
	}
	return tab.initialAgent ?? null;
}

/** Agents with at least one unread direct thread. */
export function agentsWithUnread(
	threadsByAgent: ReadonlyMap<string, readonly { id: string }[]>,
	unreadIds: ReadonlySet<string>
): Set<string> {
	const out = new Set<string>();
	for (const [agentId, threads] of threadsByAgent) {
		if (threads.some((thread) => unreadIds.has(thread.id))) {
			out.add(agentId);
		}
	}
	return out;
}
