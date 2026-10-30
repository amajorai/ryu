import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { byRecency } from "./persona-model-order.ts";
import { dayLabel } from "./persona-model-time.ts";

export type {
	ActivityDay,
	ActivityEntry,
	PersonaActivity,
	PersonaGoal,
} from "./persona-model-activity.ts";
export {
	agoLabel,
	countLabel,
	isThreadAnswered,
	personaActivity,
	personaGoals,
	untilLabel,
} from "./persona-model-activity.ts";
export type { PersonaIdea, PersonaIdeaGroup } from "./persona-model-ideas.ts";
export { descriptionTopics, personaIdeas } from "./persona-model-ideas.ts";
export {
	clockTime,
	dayLabel,
	dayTime,
	fullTime,
} from "./persona-model-time.ts";

/** The five sections of the Persona app, in tab-bar order. */
export const PERSONA_TABS = [
	"chat",
	"feed",
	"ideas",
	"goals",
	"activity",
] as const;
export type PersonaTab = (typeof PERSONA_TABS)[number];

export const PERSONA_TAB_LABELS: Record<PersonaTab, string> = {
	activity: "Activity",
	chat: "Chat",
	feed: "Feed",
	goals: "Goals",
	ideas: "Ideas",
};

/** How far the status line under the persona's name is unfolded. */
export type StatusDepth = 0 | 1 | 2;

/** The persona's threads, pinned first, then most recent. */
export function personaThreads(
	snapshot: InterfaceSnapshot,
	agentId: string | null
): InterfaceThread[] {
	if (!agentId) {
		return [];
	}
	return snapshot.threads
		.filter((thread) => thread.agentIds.includes(agentId))
		.sort((a, b) => Number(b.pinned) - Number(a.pinned) || byRecency(a, b));
}

/**
 * The persona to show first: the agent behind the most recent conversation,
 * so opening the app lands on whoever you last talked to.
 */
export function defaultPersonaId(snapshot: InterfaceSnapshot): string | null {
	const recent = [...snapshot.threads].sort(byRecency);
	for (const thread of recent) {
		const owner = thread.agentIds.find((id) =>
			snapshot.agents.some((agent) => agent.id === id)
		);
		if (owner) {
			return owner;
		}
	}
	return snapshot.agents[0]?.id ?? null;
}

/** The persona that owns a thread, preferring the current one when shared. */
export function personaForThread(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread | undefined,
	current: string | null
): string | null {
	if (!thread) {
		return current;
	}
	if (current && thread.agentIds.includes(current)) {
		return current;
	}
	return (
		thread.agentIds.find((id) =>
			snapshot.agents.some((agent) => agent.id === id)
		) ?? current
	);
}

/**
 * The persona's main conversation: its one-to-one thread, chosen so it
 * stays put while new chats arrive. A pinned one wins; otherwise the one
 * with the most messages, then the one least recently touched, so a fresh
 * side chat (few messages, just updated) never takes over. Group threads are
 * side chats; with no one-to-one thread the busiest shared one stands in.
 */
export function mainThread(
	threads: InterfaceThread[],
	agentId: string | null
): InterfaceThread | undefined {
	const direct = threads.filter(
		(thread) => thread.agentIds.length === 1 && thread.agentIds[0] === agentId
	);
	const pool = direct.length > 0 ? direct : threads;
	return [...pool].sort(
		(a, b) =>
			Number(b.pinned) - Number(a.pinned) ||
			b.messageCount - a.messageCount ||
			a.updatedAt.localeCompare(b.updatedAt) ||
			a.id.localeCompare(b.id)
	)[0];
}

/** Every other thread of the persona, newest first. */
export function sideChats(
	threads: InterfaceThread[],
	main: InterfaceThread | undefined
): InterfaceThread[] {
	return threads
		.filter((thread) => thread.id !== main?.id)
		.sort((a, b) => byRecency(a, b));
}

export interface PersonaStatus {
	/** The one-liner under the persona's name ("Launch week plan · Your turn"). */
	headline: string;
	/** What the lead task is doing ("Working"), empty when idle. */
	label: string;
	/** The status that colors the headline's mark. */
	status: ThreadStatus | "idle";
	/** Threads in motion (or waiting on someone), most urgent first. */
	steps: InterfaceThread[];
	totals: {
		lastActiveAt: string | null;
		messages: number;
		threads: number;
	};
}

/**
 * What the persona's one-liner leads with: live work first (that is what
 * "what is it doing" means), then a stopped run, then your message it has
 * not picked up, then a reply waiting on you.
 */
const STEP_ORDER: ThreadStatus[] = [
	"working",
	"attention",
	"waiting",
	"your-turn",
];

function stepRank(thread: InterfaceThread): number {
	const rank = STEP_ORDER.indexOf(threadStatus(thread));
	return rank === -1 ? STEP_ORDER.length : rank;
}

/** The state that follows the task in the one-liner. */
export const STEP_LABELS: Record<ThreadStatus, string> = {
	attention: "Run stopped",
	quiet: "Not started",
	waiting: "Queued",
	working: "Working",
	"your-turn": "Your turn",
};

/**
 * The three-layer status line: an essential one-liner, the steps behind it
 * (the persona's running, failed, waiting and replied threads), and the
 * totals the detail layer shows.
 */
export function personaStatus(
	agent: InterfaceAgent | undefined,
	threads: InterfaceThread[]
): PersonaStatus {
	const steps = threads
		.filter((thread) => threadStatus(thread) !== "quiet")
		.sort((a, b) => stepRank(a) - stepRank(b) || byRecency(a, b));
	const latest = [...threads].sort(byRecency)[0];
	const totals = {
		lastActiveAt: latest?.updatedAt ?? null,
		messages: threads.reduce((sum, thread) => sum + thread.messageCount, 0),
		threads: threads.length,
	};
	const lead = steps[0];
	if (!lead) {
		return {
			headline: agent?.description || "Free to chat",
			label: "",
			status: "idle",
			steps,
			totals,
		};
	}
	const status = threadStatus(lead);
	const label = STEP_LABELS[status];
	return {
		headline: `${lead.title || "Untitled"} · ${label}`,
		label,
		status,
		steps,
		totals,
	};
}

export interface FeedDay {
	key: string;
	label: string;
	threads: InterfaceThread[];
}

/**
 * The feed: every thread with something to say, newest first, grouped by
 * local day. `agentId` narrows it to one persona.
 */
export function projectFeed(
	snapshot: InterfaceSnapshot,
	agentId: string | null,
	now: number = Date.now()
): FeedDay[] {
	const days: FeedDay[] = [];
	const threads = snapshot.threads
		.filter((thread) => thread.lastMessage)
		.filter((thread) => !agentId || thread.agentIds.includes(agentId))
		.sort(byRecency);
	for (const thread of threads) {
		const key = localDayKey(new Date(thread.updatedAt));
		const last = days.at(-1);
		if (last?.key === key) {
			last.threads.push(thread);
		} else {
			days.push({
				key,
				label: dayLabel(thread.updatedAt, now),
				threads: [thread],
			});
		}
	}
	return days;
}
