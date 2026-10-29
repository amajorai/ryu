// Per-section chat view options: how a chat section groups and filters its rows.
//
// Every chat section (Pinned, Chats, Projects, Archived) keeps its own view, saved
// next to the per-section sort and page size. This module is the pure half — the
// vocabulary, the saved-state boundary, and the rules that classify, filter and
// group conversations — so it can be tested without mounting the sidebar.

import { z } from "zod";
import { conversationRunStatusMeta } from "@/src/lib/conversation-run-status.ts";
import { folderKey } from "@/src/lib/folder-path.ts";
import { resourceVisibilityGroup } from "@/src/lib/resource-visibility.ts";
import type { Conversation } from "@/types/chat.ts";
import { isSectionKey, type SectionKey } from "./sidebar-sections.ts";

/** How a section splits its chats into collapsible groups. `default` keeps the
 *  section's historical layout (Chats: Private/Team; others: the global "Group
 *  lists by date" setting). */
export const chatGroupBySchema = z.enum([
	"default",
	"none",
	"date",
	"status",
	"project",
	"agent",
	"environment",
	"visibility",
	"custom",
]);
export type ChatGroupBy = z.output<typeof chatGroupBySchema>;

/** What a chat is doing, most urgent first. */
export const chatStatusSchema = z.enum([
	"attention",
	"running",
	"unread",
	"idle",
]);
export type ChatStatus = z.output<typeof chatStatusSchema>;

/** Where a chat runs: a plain chat, a workspace folder, or its own worktree. */
export const chatEnvironmentSchema = z.enum(["chat", "workspace", "worktree"]);
export type ChatEnvironment = z.output<typeof chatEnvironmentSchema>;

/** How recently a chat had activity. */
export const chatActivitySchema = z.enum([
	"any",
	"today",
	"week",
	"month",
	"stale",
]);
export type ChatActivity = z.output<typeof chatActivitySchema>;

const chatFiltersSchema = z.object({
	activity: chatActivitySchema.catch("any"),
	agentIds: z.array(z.string()).catch([]),
	environments: z.array(chatEnvironmentSchema).catch([]),
	statuses: z.array(chatStatusSchema).catch([]),
});
export type ChatFilters = z.output<typeof chatFiltersSchema>;

const chatSectionViewSchema = z.object({
	filters: chatFiltersSchema.catch(() => emptyChatFilters()),
	groupBy: chatGroupBySchema.catch("default"),
});
export type ChatSectionView = z.output<typeof chatSectionViewSchema>;

export function emptyChatFilters(): ChatFilters {
	return { activity: "any", agentIds: [], environments: [], statuses: [] };
}

export const DEFAULT_CHAT_SECTION_VIEW: ChatSectionView = {
	filters: emptyChatFilters(),
	groupBy: "default",
};

export type ChatSectionViews = Partial<Record<SectionKey, ChatSectionView>>;

const chatSectionViewsInputSchema = z.record(
	z.string(),
	chatSectionViewSchema.optional().catch(undefined)
);

/** Saved rows are independent: one malformed section must not reset another. */
export function parseChatSectionViews(
	input: Parameters<typeof chatSectionViewsInputSchema.parse>[0]
): ChatSectionViews {
	const result: ChatSectionViews = {};
	const parsed = chatSectionViewsInputSchema.safeParse(input);
	if (!parsed.success) {
		return result;
	}
	for (const [key, value] of Object.entries(parsed.data)) {
		if (isSectionKey(key) && value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}

export const CHAT_GROUP_BY_OPTIONS: readonly {
	label: string;
	value: ChatGroupBy;
}[] = [
	{ label: "Default", value: "default" },
	{ label: "None", value: "none" },
	{ label: "Date", value: "date" },
	{ label: "Status", value: "status" },
	{ label: "Project", value: "project" },
	{ label: "Agent", value: "agent" },
	{ label: "Environment", value: "environment" },
	{ label: "Visibility", value: "visibility" },
	{ label: "Custom groups", value: "custom" },
];

export const CHAT_STATUS_LABELS: Record<ChatStatus, string> = {
	attention: "Needs attention",
	idle: "Idle",
	running: "Running",
	unread: "Unread",
};

export const CHAT_ENVIRONMENT_LABELS: Record<ChatEnvironment, string> = {
	chat: "Chat only",
	workspace: "Workspace folder",
	worktree: "Worktree",
};

export const CHAT_ACTIVITY_LABELS: Record<ChatActivity, string> = {
	any: "Any time",
	month: "Last 30 days",
	stale: "Older than 30 days",
	today: "Last 24 hours",
	week: "Last 7 days",
};

const STATUS_ORDER: readonly ChatStatus[] = chatStatusSchema.options;
const ENVIRONMENT_ORDER: readonly ChatEnvironment[] =
	chatEnvironmentSchema.options;

/** Live state the classifier needs beyond the conversation row itself. */
export interface ChatClassifyContext {
	/** Main threads with a running spawned session (not rows of their own). */
	runningIds?: ReadonlySet<string>;
	unreadIds: ReadonlySet<string>;
}

export function chatStatusOf(
	conversation: Conversation,
	context: ChatClassifyContext
): ChatStatus {
	const meta = conversationRunStatusMeta(conversation.runStatus);
	if (meta?.needsAttention) {
		return "attention";
	}
	if (meta?.isRunning || context.runningIds?.has(conversation.id)) {
		return "running";
	}
	if (context.unreadIds.has(conversation.id)) {
		return "unread";
	}
	return "idle";
}

/** Lower is more urgent; used by the "Status" sort. */
export function chatStatusRank(status: ChatStatus): number {
	return STATUS_ORDER.indexOf(status);
}

export function chatEnvironmentOf(conversation: Conversation): ChatEnvironment {
	if (conversation.worktreePath) {
		return "worktree";
	}
	return conversation.folderPath ? "workspace" : "chat";
}

/** The agent that last took the thread — the one its row leads with. */
export function latestChatAgentId(conversation: Conversation): string | null {
	const participants = conversation.participants ?? [];
	if (participants.length > 1) {
		return participants.at(-1) ?? null;
	}
	return conversation.agentId ?? participants[0] ?? null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function matchesActivity(
	updatedAt: number,
	activity: ChatActivity,
	now: number
): boolean {
	const age = now - updatedAt;
	switch (activity) {
		case "today":
			return age <= DAY_MS;
		case "week":
			return age <= 7 * DAY_MS;
		case "month":
			return age <= 30 * DAY_MS;
		case "stale":
			return age > 30 * DAY_MS;
		default:
			return true;
	}
}

/** Number of active filter dimensions, for the header badge. */
export function activeChatFilterCount(filters: ChatFilters): number {
	return (
		(filters.statuses.length > 0 ? 1 : 0) +
		(filters.environments.length > 0 ? 1 : 0) +
		(filters.agentIds.length > 0 ? 1 : 0) +
		(filters.activity === "any" ? 0 : 1)
	);
}

/** Keep the chats that pass every active filter (OR within one dimension). */
export function filterChats(
	conversations: readonly Conversation[],
	filters: ChatFilters,
	context: ChatClassifyContext,
	now: number = Date.now()
): Conversation[] {
	if (activeChatFilterCount(filters) === 0) {
		return conversations as Conversation[];
	}
	const statuses = new Set(filters.statuses);
	const environments = new Set(filters.environments);
	const agents = new Set(filters.agentIds);
	return conversations.filter((conversation) => {
		if (
			statuses.size > 0 &&
			!statuses.has(chatStatusOf(conversation, context))
		) {
			return false;
		}
		if (
			environments.size > 0 &&
			!environments.has(chatEnvironmentOf(conversation))
		) {
			return false;
		}
		if (agents.size > 0) {
			const ids = new Set([
				...(conversation.participants ?? []),
				...(conversation.agentId ? [conversation.agentId] : []),
			]);
			if (![...ids].some((id) => agents.has(id))) {
				return false;
			}
		}
		return matchesActivity(conversation.updatedAt, filters.activity, now);
	});
}

/** One collapsible group of chats. */
export interface ChatGroup {
	/** Project groups only: the folder a chat dropped on the group moves into
	 *  (`null` for **No project**). Keys are normalized; this keeps a real path. */
	folderPath?: string | null;
	items: Conversation[];
	key: string;
	label: string;
}

/** Everything grouping needs from the sidebar to name groups. */
export interface ChatGroupContext extends ChatClassifyContext {
	agentName: (agentId: string) => string;
	/** The custom group a chat is filed under, by id and label. */
	customGroupOf: (conversation: Conversation) => { id: string; label: string };
	/** Every custom group in display order, so empty ones still render. */
	customGroups: readonly { id: string; label: string }[];
	/** The folder that stands for a folder's project: the first folder of a
	 *  multi-folder workspace project, else the folder itself (the default). */
	projectFolder?: (folderPath: string) => string;
	projectName: (folderPath: string) => string;
}

const NO_PROJECT_KEY = "project:none";
const NO_AGENT_KEY = "agent:none";

/** The group key a chat lands in for `groupBy` (not used for date/none/default). */
export function chatGroupKey(
	conversation: Conversation,
	groupBy: ChatGroupBy,
	context: ChatGroupContext
): { folderPath?: string | null; key: string; label: string } {
	switch (groupBy) {
		case "status": {
			const status = chatStatusOf(conversation, context);
			return { key: `status:${status}`, label: CHAT_STATUS_LABELS[status] };
		}
		case "environment": {
			const environment = chatEnvironmentOf(conversation);
			return {
				key: `environment:${environment}`,
				label: CHAT_ENVIRONMENT_LABELS[environment],
			};
		}
		case "project": {
			if (!conversation.folderPath) {
				return { folderPath: null, key: NO_PROJECT_KEY, label: "No project" };
			}
			// Keyed like the Projects section: `~/x` and `~/x/`, or two folders of
			// one workspace project, are one group rather than two with one name.
			const folder =
				context.projectFolder?.(conversation.folderPath) ??
				conversation.folderPath;
			return {
				folderPath: folder,
				key: `project:${folderKey(folder)}`,
				label: context.projectName(folder),
			};
		}
		case "agent": {
			const agentId = latestChatAgentId(conversation);
			return agentId
				? { key: `agent:${agentId}`, label: context.agentName(agentId) }
				: { key: NO_AGENT_KEY, label: "No agent" };
		}
		case "visibility":
			return resourceVisibilityGroup(conversation.visibility) === "team"
				? { key: "visibility:team", label: "Team" }
				: { key: "visibility:private", label: "Private" };
		case "custom": {
			const group = context.customGroupOf(conversation);
			return { key: `custom:${group.id}`, label: group.label };
		}
		default:
			return { key: "all", label: "All" };
	}
}

function fixedGroupOrder(groupBy: ChatGroupBy): string[] {
	switch (groupBy) {
		case "status":
			return STATUS_ORDER.map((status) => `status:${status}`);
		case "environment":
			return ENVIRONMENT_ORDER.map(
				(environment) => `environment:${environment}`
			);
		case "visibility":
			return ["visibility:private", "visibility:team"];
		default:
			return [];
	}
}

/**
 * Split chats into groups, keeping each group's incoming (already sorted) order.
 * Status, environment and visibility groups follow a fixed order; custom groups
 * follow the user's group order and show even when empty (so a chat can be
 * dropped into one); project and agent groups are alphabetical, with the
 * "No project" / "No agent" bucket last.
 */
export function groupChats(
	conversations: readonly Conversation[],
	groupBy: ChatGroupBy,
	context: ChatGroupContext
): ChatGroup[] {
	const groups = new Map<string, ChatGroup>();
	if (groupBy === "custom") {
		for (const group of context.customGroups) {
			groups.set(`custom:${group.id}`, {
				items: [],
				key: `custom:${group.id}`,
				label: group.label,
			});
		}
	}
	for (const conversation of conversations) {
		const { folderPath, key, label } = chatGroupKey(
			conversation,
			groupBy,
			context
		);
		const group = groups.get(key);
		if (group) {
			group.items.push(conversation);
		} else {
			groups.set(key, { folderPath, items: [conversation], key, label });
		}
	}
	const list = [...groups.values()];
	const fixed = fixedGroupOrder(groupBy);
	if (fixed.length > 0) {
		return list.sort((a, b) => fixed.indexOf(a.key) - fixed.indexOf(b.key));
	}
	if (groupBy === "project" || groupBy === "agent") {
		const lastKey = groupBy === "project" ? NO_PROJECT_KEY : NO_AGENT_KEY;
		return list.sort((a, b) => {
			if (a.key === lastKey || b.key === lastKey) {
				return a.key === lastKey ? 1 : -1;
			}
			return a.label.localeCompare(b.label);
		});
	}
	return list;
}
