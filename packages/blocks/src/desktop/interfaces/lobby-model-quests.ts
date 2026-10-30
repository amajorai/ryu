import {
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import type { LobbyMember } from "./lobby-model.ts";
import {
	byRecency,
	MILESTONE_TIERS,
	threadTitle,
	totalMessages,
	XP_PER_MESSAGE,
} from "./lobby-model-shared.ts";

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
