import {
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Lobby view model: pure functions from the snapshot to what the lobby shows.
 * The game vocabulary maps onto real data only:
 * - XP is messages exchanged (100 XP per message), levels every 1,000 XP;
 * - a squad member's state comes from that agent's threads;
 * - daily quests are conversations waiting on you, weekly quests are teams and
 *   projects (finished threads out of all of them), and milestones count the
 *   messages traded with each agent against fixed tiers.
 */

export const XP_PER_MESSAGE = 100;
export const XP_PER_LEVEL = 1000;
/** The most agents on the podium (the "Squad size" setting's ceiling and default). */
export const SQUAD_SIZE = 4;
export const MILESTONE_TIERS: readonly number[] = [10, 25, 50, 100, 250];

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

export function totalMessages(threads: readonly InterfaceThread[]): number {
	let sum = 0;
	for (const thread of threads) {
		sum += Math.max(0, thread.messageCount);
	}
	return sum;
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

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
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
// Quests
// ---------------------------------------------------------------------------

export type QuestKind = "daily" | "milestone" | "weekly";

export const QUEST_KINDS: readonly QuestKind[] = [
	"daily",
	"weekly",
	"milestone",
];

export const QUEST_KIND_LABELS: Record<QuestKind, string> = {
	daily: "Daily quests",
	milestone: "Milestones",
	weekly: "Weekly quests",
};

export const QUEST_KIND_DESCRIPTIONS: Record<QuestKind, string> = {
	daily: "Conversations with a reply or a failed run waiting on you.",
	milestone: "Messages traded with each agent. Reach the tier to claim.",
	weekly: "Teams and projects. Finish every thread to claim.",
};

export type QuestAction =
	| { kind: "open"; threadId: string }
	| { agentId?: string; kind: "start"; projectId?: string; teamId?: string };

export interface LobbyQuest {
	action: QuestAction;
	/** Agent shown beside the quest, when it has one. */
	agentId: string | null;
	complete: boolean;
	/** What the quest asks for, in plain words. */
	detail: string;
	goal: number;
	/** The team or project behind a weekly quest. */
	groupId: string | null;
	id: string;
	kind: QuestKind;
	/** The count the progress bar measures, in words: "31 / 50 messages". */
	metric: string;
	progress: number;
	title: string;
	updatedAt: string | null;
	xp: number;
}

function threadTitle(thread: InterfaceThread): string {
	return thread.title.trim() || "Untitled thread";
}

function agentNames(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): string {
	const names = thread.agentIds
		.map((id) => snapshot.agents.find((agent) => agent.id === id)?.name)
		.filter((name): name is string => Boolean(name));
	if (names.length === 0) {
		return "No agent";
	}
	if (names.length === 1) {
		return names[0] ?? "";
	}
	return `${names[0]} and ${names.length - 1} more`;
}

function dailyDetail(status: ThreadStatus, who: string): string {
	switch (status) {
		case "attention":
			return `Check the failed run · ${who}`;
		case "your-turn":
			return who === "No agent" ? "Reply to the thread" : `Reply to ${who}`;
		case "working":
			return `${who} is working on it`;
		default:
			return `Waiting on ${who === "No agent" ? "an agent" : who} to pick it up`;
	}
}

/**
 * A daily's two steps: the agent's turn (picked up and working), then yours
 * (a reply or a failed run to check). Queued work has done neither.
 */
const DAILY_STEPS = 2;

const DAILY_METRIC: Record<ThreadStatus, string> = {
	attention: "Run failed",
	quiet: "Done",
	waiting: "Queued",
	working: "Agent's turn",
	"your-turn": "Your turn",
};

function dailyProgress(status: ThreadStatus): number {
	if (status === "attention" || status === "your-turn") {
		return DAILY_STEPS;
	}
	return status === "working" ? 1 : 0;
}

/**
 * Daily quests: open conversations. Those waiting on you (a reply, or a failed
 * run) are complete and ready to claim; live and queued ones are in progress.
 */
export function dailyQuests(snapshot: InterfaceSnapshot): LobbyQuest[] {
	const rank = (thread: InterfaceThread) =>
		THREAD_STATUS_ORDER.indexOf(threadStatus(thread));
	return snapshot.threads
		.filter((thread) => threadStatus(thread) !== "quiet")
		.sort((a, b) => rank(a) - rank(b) || byRecency(a, b))
		.map((thread) => {
			const status = threadStatus(thread);
			const complete = status === "attention" || status === "your-turn";
			return {
				action: { kind: "open", threadId: thread.id },
				agentId: thread.agentIds[0] ?? null,
				complete,
				detail: dailyDetail(status, agentNames(snapshot, thread)),
				goal: DAILY_STEPS,
				groupId: null,
				id: `daily-${thread.id}`,
				kind: "daily",
				metric: DAILY_METRIC[status],
				progress: dailyProgress(status),
				title: threadTitle(thread),
				updatedAt: thread.updatedAt,
				xp: Math.max(1, thread.messageCount) * XP_PER_MESSAGE,
			};
		});
}

function groupStart(group: InterfaceGroup): QuestAction {
	return group.kind === "project"
		? { kind: "start", projectId: group.id }
		: { kind: "start", teamId: group.id };
}

/** Weekly quests: one per team and project, finished threads out of all. */
export function weeklyQuests(snapshot: InterfaceSnapshot): LobbyQuest[] {
	return [...snapshot.groups]
		.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
		.map((group) => {
			const threads = snapshot.threads
				.filter((thread) =>
					group.kind === "project"
						? thread.projectId === group.id
						: thread.teamId === group.id
				)
				.sort(byRecency);
			const finished = threads.filter(
				(thread) => threadStatus(thread) === "your-turn"
			).length;
			const open = threads.find(
				(thread) => threadStatus(thread) !== "your-turn"
			);
			const target = open ?? threads[0];
			const complete = threads.length > 0 && finished === threads.length;
			const kindLabel = group.kind === "project" ? "Project" : "Team";
			const memberCount = group.memberAgentIds.length;
			const detail = `${kindLabel} · ${memberCount} ${memberCount === 1 ? "agent" : "agents"}`;
			const metric =
				threads.length === 0
					? "No threads yet"
					: `${finished} / ${threads.length} ${threads.length === 1 ? "thread" : "threads"} finished`;
			return {
				action: target
					? { kind: "open", threadId: target.id }
					: groupStart(group),
				agentId: group.memberAgentIds[0] ?? null,
				complete,
				detail,
				goal: Math.max(1, threads.length),
				groupId: group.id,
				id: `weekly-${group.id}`,
				kind: "weekly",
				metric,
				progress: finished,
				title: group.name,
				updatedAt: threads[0]?.updatedAt ?? null,
				xp: Math.max(1, totalMessages(threads)) * XP_PER_MESSAGE,
			};
		});
}

export interface MilestoneTier {
	goal: number;
	/** 1-based tier number. */
	tier: number;
}

/** The tier an agent is working toward (the last one once every tier is met). */
export function nextMilestone(messages: number): MilestoneTier {
	const index = MILESTONE_TIERS.findIndex((goal) => messages < goal);
	const tierIndex = index === -1 ? MILESTONE_TIERS.length - 1 : index;
	return {
		goal: MILESTONE_TIERS[tierIndex] ?? 0,
		tier: tierIndex + 1,
	};
}

/** Milestones: per agent, messages traded toward the next tier. */
export function milestoneQuests(members: readonly LobbyMember[]): LobbyQuest[] {
	return [...members]
		.sort(
			(a, b) =>
				b.messages - a.messages || a.agent.name.localeCompare(b.agent.name)
		)
		.map((member) => {
			const { goal, tier } = nextMilestone(member.messages);
			const latest = member.threads[0];
			return {
				action: latest
					? { kind: "open", threadId: latest.id }
					: { agentId: member.agent.id, kind: "start" },
				agentId: member.agent.id,
				complete: member.messages >= goal,
				detail: `Tier ${tier} of ${MILESTONE_TIERS.length}`,
				goal,
				groupId: null,
				id: `milestone-${member.agent.id}`,
				kind: "milestone",
				metric: `${Math.min(member.messages, goal)} / ${goal} messages`,
				progress: Math.min(member.messages, goal),
				title: `Talk shop with ${member.agent.name}`,
				updatedAt: member.lastActive,
				xp: goal * XP_PER_MESSAGE,
			};
		});
}

export interface QuestBoard {
	daily: LobbyQuest[];
	milestone: LobbyQuest[];
	weekly: LobbyQuest[];
}

/** How many asks the user answered while the lobby was open, and what waits. */
export interface AskTally {
	/** Asks answered today through the ask card, once each left the snapshot. */
	answered: number;
	/** The first blocking ask's thread, to open from the quest. */
	firstThreadId: string | null;
	/** Blocking asks waiting now, less the answers on their way. */
	waiting: number;
}

/** An answer sent through the ask card, waiting for its ask to leave. */
export interface SentAnswer {
	/** When it was sent (wall clock, ms). */
	at: number;
	/** When the ask expires (ms), if it does. */
	expiresAt: number | null;
	id: string;
}

/** How long an answered ask may take to leave the snapshot. */
export const ANSWER_GRACE_MS = 10_000;

/**
 * Answers sent through the ask card, settled against the live asks. An ask
 * that left the snapshot within the grace, before it expired, was answered
 * (`confirmed`). One still listed waits out the grace (`sent`); after it,
 * or once it expired, it is dropped and counts as waiting again: the host
 * resolves answerAsk without answering when it only opened the thread.
 */
export function settleAnswers(
	sent: readonly SentAnswer[],
	live: ReadonlySet<string>,
	wallMs: number,
	clockMs: number
): { confirmed: string[]; sent: SentAnswer[] } {
	const confirmed: string[] = [];
	const kept: SentAnswer[] = [];
	for (const answer of sent) {
		const fresh =
			wallMs - answer.at <= ANSWER_GRACE_MS &&
			(answer.expiresAt === null || answer.expiresAt > clockMs);
		if (!fresh) {
			continue;
		}
		if (live.has(answer.id)) {
			kept.push(answer);
		} else {
			confirmed.push(answer.id);
		}
	}
	return { confirmed, sent: kept };
}

/** When a thread's newest turn finished, if the host saw it finish. */
function finishedAt(thread: InterfaceThread): string | null {
	return thread.outcome?.finishedAt ?? thread.runEndedAt ?? null;
}

/**
 * Daily quests from the act layer: one to answer what needs you (asks
 * answered while the lobby was open, out of those plus the ones waiting),
 * and one per run that finished today, ready to claim. Times come only
 * from exact run ends, never from `updatedAt`.
 */
export function actDailyQuests(
	snapshot: InterfaceSnapshot,
	asks: AskTally,
	nowMs: number
): LobbyQuest[] {
	const today = localDayKey(new Date(nowMs));
	const answers: LobbyQuest = {
		action: asks.firstThreadId
			? { kind: "open", threadId: asks.firstThreadId }
			: { kind: "start" },
		agentId: null,
		complete: asks.waiting === 0 && asks.answered > 0,
		detail:
			asks.waiting > 0
				? `${asks.waiting} ${asks.waiting === 1 ? "ask needs" : "asks need"} you`
				: "Nothing needs you",
		goal: Math.max(1, asks.answered + asks.waiting),
		groupId: null,
		id: "daily-asks",
		kind: "daily",
		metric:
			asks.answered + asks.waiting > 0
				? `${asks.answered} / ${asks.answered + asks.waiting} answered`
				: "Nothing waiting",
		progress: asks.answered,
		title: "Answer what needs you",
		updatedAt: null,
		xp: Math.max(1, asks.answered + asks.waiting) * XP_PER_MESSAGE,
	};
	const finished = snapshot.threads
		.filter((thread) => {
			// A failed run is no quest to claim (the HUD counts it failed).
			const at = finishedAt(thread);
			return (
				thread.runState !== "failed" &&
				at !== null &&
				localDayKey(new Date(at)) === today
			);
		})
		.sort(
			(a, b) =>
				Date.parse(finishedAt(b) ?? "") - Date.parse(finishedAt(a) ?? "") ||
				a.id.localeCompare(b.id)
		)
		.map(
			(thread): LobbyQuest => ({
				action: { kind: "open", threadId: thread.id },
				agentId: thread.agentIds[0] ?? null,
				complete: true,
				detail: `${agentNames(snapshot, thread)} finished a run`,
				goal: 1,
				groupId: null,
				id: `daily-done-${thread.id}`,
				kind: "daily",
				metric: "Finished today",
				progress: 1,
				title: thread.outcome?.headline ?? threadTitle(thread),
				updatedAt: finishedAt(thread),
				xp: Math.max(1, thread.messageCount) * XP_PER_MESSAGE,
			})
		);
	return [answers, ...finished];
}

export function buildQuestBoard(
	snapshot: InterfaceSnapshot,
	members: readonly LobbyMember[],
	/** The act layer's ask tally: dailies count asks answered and runs finished today. */
	asks?: AskTally,
	nowMs = Date.now()
): QuestBoard {
	return {
		daily: asks ? actDailyQuests(snapshot, asks, nowMs) : dailyQuests(snapshot),
		milestone: milestoneQuests(members),
		weekly: weeklyQuests(snapshot),
	};
}

export function claimableCount(quests: readonly LobbyQuest[]): number {
	return quests.filter((quest) => quest.complete).length;
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
