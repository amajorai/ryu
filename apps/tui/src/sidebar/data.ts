// Sidebar data layer - loads every live-data section's source from Core and maps
// it to a uniform SidebarItem shape. Wired in the FOUNDATION (not per-surface) so
// the section loaders live in one place and downstream surface builders never
// touch data fetching for the sidebar.
//
// Sources:
//   - agents / teams / spaces / meetings / workflows: typed @ryuhq/core-client modules
//   - conversations: raw request() GET /api/conversations (the spaces.tsx pattern),
//     since no typed module exposes the bare list
// Buckets derived from conversations:
//   - projects: conversations grouped by their workspace folder (degrades to none
//     when Core does not return a folder/project field)
//   - chats: folderless conversations
//   - pinned / archived: flag buckets (degrade to empty when the flag is absent)

import { fetchAgents } from "@ryuhq/core-client/agents";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { listMeetings } from "@ryuhq/core-client/meetings";
import { fetchSpaces } from "@ryuhq/core-client/spaces";
import { fetchTeams } from "@ryuhq/core-client/teams";
import { fetchWorkflows } from "@ryuhq/core-client/workflows";

export interface SidebarItem {
	/** Optional trailing count/state chip. */
	badge?: string;
	id: string;
	label: string;
	/** openTab target when the item is activated. */
	path: string;
}

export interface ProjectGroup {
	chats: SidebarItem[];
	id: string;
	name: string;
}

export interface SidebarData {
	agents: SidebarItem[];
	archived: SidebarItem[];
	chats: SidebarItem[];
	meetings: SidebarItem[];
	pinned: SidebarItem[];
	projects: ProjectGroup[];
	spaces: SidebarItem[];
	teams: SidebarItem[];
	workflows: SidebarItem[];
}

export const emptySidebarData: SidebarData = {
	agents: [],
	teams: [],
	spaces: [],
	meetings: [],
	workflows: [],
	pinned: [],
	projects: [],
	chats: [],
	archived: [],
};

const DATE_SPLIT = "T";
// Max absolute epoch (ms) the ECMAScript Date can represent (±8.64e15). A finite
// number past this makes `new Date(raw).toISOString()` throw RangeError; since
// bucketConversations runs OUTSIDE `settled`, an unguarded throw would reject the
// entire sidebar load. Treat an out-of-range timestamp as "no badge".
const MAX_EPOCH_MS = 8.64e15;

// GET /api/conversations wire shape (snake_case). The flag/folder fields are
// optional: Core may not serialize them, in which case the derived buckets are
// simply empty (graceful degradation).
interface ConversationWire {
	archived?: boolean | null;
	folder?: string | null;
	id: string;
	message_count?: number | null;
	pinned?: boolean | null;
	project?: string | null;
	title?: string | null;
	updated_at?: string | number | null;
}

function convLabel(wire: ConversationWire): string {
	const trimmed = wire.title?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : "untitled";
}

function convBadge(wire: ConversationWire): string | undefined {
	const raw = wire.updated_at;
	// Core serializes updated_at as epoch milliseconds (number); older shapes used
	// an ISO string. Normalise both to a YYYY-MM-DD badge, and ignore anything else.
	if (typeof raw === "number" && Number.isFinite(raw)) {
		if (Math.abs(raw) > MAX_EPOCH_MS) {
			return undefined;
		}
		return new Date(raw).toISOString().split(DATE_SPLIT)[0];
	}
	const date = typeof raw === "string" ? raw.split(DATE_SPLIT)[0] : undefined;
	return date && date.length > 0 ? date : undefined;
}

function toConversationItem(wire: ConversationWire): SidebarItem {
	return {
		id: wire.id,
		label: convLabel(wire),
		path: "/chat",
		badge: convBadge(wire),
	};
}

async function fetchConversations(
	target: ApiTarget
): Promise<ConversationWire[]> {
	const json = await request<
		ConversationWire[] | { conversations?: ConversationWire[] }
	>(target, "/api/conversations");
	return Array.isArray(json) ? json : (json.conversations ?? []);
}

// Group conversations into projects (by folder/project field) + folderless chats
// + pinned/archived flag buckets. Absent fields collapse to empty buckets.
function bucketConversations(convs: ConversationWire[]): {
	archived: SidebarItem[];
	chats: SidebarItem[];
	pinned: SidebarItem[];
	projects: ProjectGroup[];
} {
	const projectMap = new Map<string, SidebarItem[]>();
	const chats: SidebarItem[] = [];
	const pinned: SidebarItem[] = [];
	const archived: SidebarItem[] = [];

	for (const conv of convs) {
		const item = toConversationItem(conv);
		if (conv.archived) {
			archived.push(item);
			continue;
		}
		if (conv.pinned) {
			pinned.push(item);
		}
		const folder = conv.folder ?? conv.project ?? null;
		if (folder) {
			const list = projectMap.get(folder) ?? [];
			list.push(item);
			projectMap.set(folder, list);
		} else {
			chats.push(item);
		}
	}

	const projects: ProjectGroup[] = [...projectMap.entries()].map(
		([name, groupChats]) => ({ id: name, name, chats: groupChats })
	);
	return { projects, chats, pinned, archived };
}

async function settled<T>(work: Promise<T>, fallback: T): Promise<T> {
	try {
		return await work;
	} catch {
		return fallback;
	}
}

/** Load every sidebar section for the given node. Any single source failing
 * degrades that section to empty rather than failing the whole load. */
export async function loadSidebarData(target: ApiTarget): Promise<SidebarData> {
	const [agents, teams, spaces, meetings, workflows, convs] = await Promise.all(
		[
			settled(fetchAgents(target), []),
			settled(fetchTeams(target), []),
			settled(fetchSpaces(target), []),
			settled(listMeetings(target), []),
			settled(fetchWorkflows(target), []),
			settled(fetchConversations(target), []),
		]
	);
	const buckets = bucketConversations(convs);
	return {
		agents: agents.map((agent) => ({
			id: agent.id,
			label: agent.name,
			path: "/agents",
		})),
		teams: teams.map((team) => ({
			id: team.id,
			label: team.name,
			path: "/teams",
		})),
		spaces: spaces.map((space) => ({
			id: space.id,
			label: space.name,
			path: "/spaces",
			badge:
				typeof space.documentCount === "number"
					? `${space.documentCount}`
					: undefined,
		})),
		meetings: meetings.map((meeting) => ({
			id: meeting.id,
			label: meeting.title,
			path: "/meetings",
		})),
		workflows: workflows.map((workflow) => ({
			id: workflow.id,
			label: workflow.name,
			path: "/workflows",
		})),
		...buckets,
	};
}
