import {
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	byRecency,
	SQUAD_SIZE,
	threadTitle,
	totalMessages,
	XP_PER_LEVEL,
	XP_PER_MESSAGE,
} from "./lobby-model-shared.ts";

export {
	ANSWER_GRACE_MS,
	type AskTally,
	actDailyQuests,
	buildQuestBoard,
	claimableCount,
	dailyQuests,
	type LobbyQuest,
	type MilestoneTier,
	milestoneQuests,
	nextMilestone,
	QUEST_KIND_DESCRIPTIONS,
	QUEST_KIND_LABELS,
	QUEST_KINDS,
	type QuestAction,
	type QuestBoard,
	type QuestKind,
	type SentAnswer,
	settleAnswers,
	weeklyQuests,
} from "./lobby-model-quests.ts";
export {
	MILESTONE_TIERS,
	SQUAD_SIZE,
	totalMessages,
	XP_PER_LEVEL,
	XP_PER_MESSAGE,
} from "./lobby-model-shared.ts";

/**
 * Lobby view model: pure functions from the snapshot to what the lobby shows.
 * The game vocabulary maps onto real data only:
 * - XP is messages exchanged (100 XP per message), levels every 1,000 XP;
 * - a squad member's state comes from that agent's threads;
 * - daily quests are conversations waiting on you, weekly quests are teams and
 *   projects (finished threads out of all of them), and milestones count the
 *   messages traded with each agent against fixed tiers.
 */

export const LOBBY_TABS = ["lobby", "quests", "squad", "news"] as const;
export type LobbyTab = (typeof LOBBY_TABS)[number];
export const LOBBY_TAB_LABELS: Record<LobbyTab, string> = {
	lobby: "Lobby",
	news: "News",
	quests: "Quests",
	squad: "Squad",
};

export interface LobbyLevel {
	level: number;
	/** XP earned inside the current level. */
	progress: number;
	/** XP the current level takes to finish. */
	span: number;
	totalXp: number;
}

export function lobbyLevel(messages: number): LobbyLevel {
	const totalXp = Math.max(0, Math.floor(messages)) * XP_PER_MESSAGE;
	return {
		level: Math.floor(totalXp / XP_PER_LEVEL) + 1,
		progress: totalXp % XP_PER_LEVEL,
		span: XP_PER_LEVEL,
		totalXp,
	};
}

/** "1,200" in the user's locale, stable in tests. */
export function formatXp(value: number): string {
	return value.toLocaleString("en-US");
}

export type SquadState =
	| "downed"
	| "in-match"
	| "needs-you"
	| "ready"
	| "waiting";

export const SQUAD_STATE_LABELS: Record<SquadState, string> = {
	downed: "Downed",
	"in-match": "In match",
	"needs-you": "Needs you",
	ready: "Ready",
	waiting: "Waiting",
};

/** Plain words for screen readers and tooltips. */
export const SQUAD_STATE_DESCRIPTIONS: Record<SquadState, string> = {
	downed: "a run failed",
	"in-match": "working",
	"needs-you": "waiting on your reply",
	ready: "idle",
	waiting: "waiting on something",
};

/** The face a thread's agent wears, from where that thread stands. */
export const STATUS_SQUAD_STATE: Record<ThreadStatus, SquadState> = {
	attention: "downed",
	quiet: "ready",
	waiting: "ready",
	working: "in-match",
	"your-turn": "needs-you",
};

export interface LobbyMember {
	agent: InterfaceAgent;
	/** The thread that explains `state` (the live run, the failure, the reply). */
	focus: InterfaceThread | undefined;
	lastActive: string | null;
	level: LobbyLevel;
	messages: number;
	needsYou: number;
	state: SquadState;
	/** This agent's threads, newest first. */
	threads: InterfaceThread[];
	working: number;
}

function firstWith(
	threads: readonly InterfaceThread[],
	status: ThreadStatus
): InterfaceThread | undefined {
	return threads.find((thread) => threadStatus(thread) === status);
}

function memberState(
	agent: InterfaceAgent,
	threads: readonly InterfaceThread[]
): { focus: InterfaceThread | undefined; state: SquadState } {
	const live = firstWith(threads, "working");
	if (live || agent.status === "working") {
		return { focus: live ?? threads[0], state: "in-match" };
	}
	const failed = firstWith(threads, "attention");
	if (failed) {
		return { focus: failed, state: "downed" };
	}
	const reply = firstWith(threads, "your-turn");
	if (reply) {
		return { focus: reply, state: "needs-you" };
	}
	return { focus: threads[0], state: "ready" };
}

export function buildMembers(snapshot: InterfaceSnapshot): LobbyMember[] {
	const byAgent = new Map<string, InterfaceThread[]>();
	for (const thread of [...snapshot.threads].sort(byRecency)) {
		for (const agentId of thread.agentIds) {
			const list = byAgent.get(agentId) ?? [];
			list.push(thread);
			byAgent.set(agentId, list);
		}
	}
	return snapshot.agents.map((agent) => {
		const threads = byAgent.get(agent.id) ?? [];
		const messages = totalMessages(threads);
		let working = 0;
		let needsYou = 0;
		for (const thread of threads) {
			const status = threadStatus(thread);
			working += Number(status === "working");
			needsYou += Number(status === "your-turn" || status === "attention");
		}
		return {
			agent,
			...memberState(agent, threads),
			lastActive: threads[0]?.updatedAt ?? null,
			level: lobbyLevel(messages),
			messages,
			needsYou,
			threads,
			working,
		};
	});
}

/** The default squad: the most recently active agents, then by name. */
export function defaultSquadIds(
	members: readonly LobbyMember[],
	size = SQUAD_SIZE
): string[] {
	return [...members]
		.sort(
			(a, b) =>
				(b.lastActive ?? "").localeCompare(a.lastActive ?? "") ||
				a.agent.name.localeCompare(b.agent.name) ||
				a.agent.id.localeCompare(b.agent.id)
		)
		.slice(0, size)
		.map((member) => member.agent.id);
}

/**
 * The squad on stage: the user's picks that still exist, topped up from the
 * default order so the stage stays full when agents come and go.
 */
export function resolveSquad(
	members: readonly LobbyMember[],
	picked: readonly string[] | null,
	size = SQUAD_SIZE
): LobbyMember[] {
	const byId = new Map(members.map((member) => [member.agent.id, member]));
	const ids: string[] = [];
	for (const id of [...(picked ?? []), ...defaultSquadIds(members, size)]) {
		if (byId.has(id) && !ids.includes(id)) {
			ids.push(id);
		}
	}
	return ids
		.slice(0, size)
		.map((id) => byId.get(id))
		.filter((member): member is LobbyMember => member !== undefined);
}

/**
 * Put an agent in the squad. A member already in it keeps their spot; a new
 * one takes the last spot so the leader and the rest stay where they stand.
 */
export function addToSquad(
	squadIds: readonly string[],
	agentId: string,
	size = SQUAD_SIZE
): string[] {
	if (squadIds.includes(agentId)) {
		return [...squadIds];
	}
	if (squadIds.length < size) {
		return [...squadIds, agentId];
	}
	return [...squadIds.slice(0, size - 1), agentId];
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

export const NEWS_LIMIT = 8;

export interface NewsItem {
	agent: InterfaceAgent | undefined;
	status: ThreadStatus;
	thread: InterfaceThread;
	title: string;
}

/** The latest updates: the most recently active threads. */
export function newsItems(
	snapshot: InterfaceSnapshot,
	limit: number = NEWS_LIMIT
): NewsItem[] {
	return [...snapshot.threads]
		.sort(byRecency)
		.slice(0, limit)
		.map((thread) => ({
			agent: snapshot.agents.find((agent) => agent.id === thread.agentIds[0]),
			status: threadStatus(thread),
			thread,
			title: threadTitle(thread),
		}));
}

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

export interface PlayMode {
	label: string;
	projectId?: string;
	teamId?: string;
}

/**
 * The mode a new match with this member plays in: the team or project its
 * latest thread belongs to (the new thread goes there too), or SOLO.
 */
export function playMode(
	member: Pick<LobbyMember, "threads"> | undefined,
	groups: readonly InterfaceGroup[]
): PlayMode {
	const latest = member?.threads[0];
	const team = latest?.teamId
		? groups.find((group) => group.id === latest.teamId)
		: undefined;
	if (team) {
		return { label: team.name, teamId: team.id };
	}
	const project = latest?.projectId
		? groups.find((group) => group.id === latest.projectId)
		: undefined;
	if (project) {
		return { label: project.name, projectId: project.id };
	}
	return { label: "Solo" };
}

export function isLobbyTab(value: unknown): value is LobbyTab {
	return (
		typeof value === "string" &&
		(LOBBY_TABS as readonly string[]).includes(value)
	);
}

export { threadTitle };
